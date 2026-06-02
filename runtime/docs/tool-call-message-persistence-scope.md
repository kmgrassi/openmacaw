# Tool call message persistence scope

## Problem

Gateway chat already streams tool-call lifecycle events back to the browser as
`chat` events. The durable transcript only writes the user message and the
final assistant text message. The actual tool-call record is not saved as a
first-class database row.

The generated schema already includes a `tool_call` table:

- `tool_call.message_id` references `message.id`
- `tool_call.tool_id` references `tool.id`
- `tool_call.input` is nullable text
- `tool_call.output` is nullable text

Runtime currently stores only compact tool-call summaries in
`message.metadata.tool_calls` for some paths. That summary is not enough for
full tool replay because it drops the model-emitted arguments and the tool
output.

## Goal

Persist one `tool_call` row per completed or failed tool call, linked to the
assistant `message` row for the turn.

Minimum persisted shape:

```json
{
  "message_id": "<assistant-message-id>",
  "tool_id": "<nullable tool row id>",
  "input": "{\"id\":\"call_1\",\"name\":\"task.create\",\"arguments\":{...}}",
  "output": "{\"success\":true,\"result\":{...}}"
}
```

`input` and `output` are strings in the live schema, so JSON should be encoded
before insert. Do not add dual formats. If the storage type should become JSONB
later, make that schema change in `harper-server`, run schema sync here, and
update the runtime writer in the same PR set.

## Current write path

### Websocket chat

1. `GatewaySocket.ChatHandlers` handles `chat.send` and calls
   `ChatGateway.post_message/3`.
2. Runner events arrive at `GatewaySocket.handle_info/2`.
3. `RunnerEventTranslation.translate/4` forwards
   `:tool_call_started`, `:tool_call_completed`, and `:tool_call_failed`
   back to the websocket client.
4. On completion, `GatewaySocket.handle_runner_complete/3` records the final
   assistant text through `record_assistant_message/4`.
5. `GatewaySocket.MessageLogger` calls `MessageLog.record_assistant_message/5`.
6. `MessageLog.insert_message/5` posts to `/rest/v1/message` with
   `prefer: "return=minimal"`.

Important files:

| File | Why it changes |
| --- | --- |
| `apps/orchestrator/lib/symphony_elixir/message_log.ex` | Add `@tool_call_table`, return inserted assistant message ids, and insert `tool_call` rows. Current `insert_message/5` uses `return=minimal`, so it cannot link child rows. |
| `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex` | Accumulate tool-call events for a browser websocket run, then pass them when recording the final assistant message. |
| `apps/orchestrator/lib/symphony_elixir_web/gateway_socket/runner_event_translation.ex` | Today only translates tool-call events to outbound websocket frames. It should also leave enough normalized data in gateway state for persistence, or call a shared accumulator. |
| `apps/orchestrator/lib/symphony_elixir_web/gateway_socket/message_logger.ex` | Extend assistant record attrs to accept `tool_calls` and pass them to `MessageLog`. |

### Synchronous chat gateway / manager scheduler path

`SymphonyElixir.ChatGateway` already accumulates compact tool-call summaries in
its local buffer and attaches them to assistant metadata. This path should move
from metadata-only persistence to metadata plus first-class `tool_call` rows.

Important files:

| File | Why it changes |
| --- | --- |
| `apps/orchestrator/lib/symphony_elixir/chat_gateway.ex` | `apply_event/2` and `tool_call/2` currently keep only `tool`, `call_id`, `status`, `error_code`, and `retryable`. Extend this to retain input arguments and output payloads when events carry them. Pass the collected rows to `record_assistant_message/6`. |
| `apps/orchestrator/lib/symphony_elixir/message_history.ex` | Leave text-only replay unchanged in PR1. Full replay from `tool_call` rows should be a later PR after rows are being written reliably. |

## PR 1: Runtime writes `tool_call` rows

Branch suggestion: `codex/persist-tool-call-rows`

### Scope

- Add a `MessageLog.record_assistant_message/6` or option-based variant that
  accepts `tool_calls: [...]`.
- Change assistant message insert to request `return=representation` with
  `select=id` when tool calls need to be written.
- Insert child rows into `/rest/v1/tool_call` after the assistant message row
  succeeds.
- Keep persistence best-effort: if `tool_call` insert fails, log
  `gateway_message_persistence_failed` with `operation:
  "message_log.record_tool_calls"` and do not fail the chat turn.
- Preserve existing `message.metadata.tool_calls` during rollout so current
  readers do not regress. This is not a backwards-compatibility shim for input
  formats; it is duplicate read-model data while UI/read paths catch up.
- Store `tool_id` only when the runtime can resolve a real `tool.id`.
  Otherwise write `null`. Do not invent synthetic ids.

### Normalized runtime shape

Use one internal struct/map before inserting:

```elixir
%{
  "call_id" => "call_1",
  "tool_name" => "task.create",
  "status" => "ok",
  "input" => %{"id" => "call_1", "name" => "task.create", "arguments" => %{}},
  "output" => %{"success" => true, "result" => %{}},
  "tool_id" => nil
}
```

Then encode:

- `input = Jason.encode!(Map.take(call, ["call_id", "tool_name", "input"]))`
- `output = Jason.encode!(Map.take(call, ["status", "output", "error_code", "retryable"]))`

This keeps the DB shape compatible with the current text columns while keeping
the payload structured and parseable.

### Event data gaps to verify

Some current tool-call summaries may not include arguments or outputs. Before
implementation, inspect emitted payloads from:

- planner tool execution in
  `apps/orchestrator/lib/symphony_elixir/planner/model_client/openai_responses.ex`
- manager/local-model execution in `Runner.LlmToolRunner` and
  `Runner.ToolCallingLoop`
- Codex dynamic tool events in
  `apps/orchestrator/lib/symphony_elixir/codex/app_server/approvals.ex`

If a runner cannot provide full input/output yet, still write the row with the
available `call_id`, `tool_name`, and status, but leave the missing side `null`.
Do not fabricate empty JSON as a substitute for missing data.

### Tests

- Extend `apps/orchestrator/test/symphony_elixir/message_log_test.exs`:
  - assistant insert returns `id`
  - tool calls are POSTed to `/rest/v1/tool_call`
  - child insert failure logs and returns `:ok`
  - no tool calls preserves the existing minimal insert behavior if desired
- Extend gateway socket tests:
  - `tool_call_completed` event followed by final response writes a child row
  - failed runner writes no orphan `tool_call` row without an assistant message
- Extend `ChatGateway` tests:
  - buffered manager tool calls are passed to `MessageLog`

### Validation

```bash
cd apps/orchestrator
mix compile --warnings-as-errors
mix test
```

For changes touching manager/planner gateway behavior, also smoke locally:

```bash
pnpm run smoke:runtime
pnpm run smoke:manager -- --workspace-id <workspace-id>
```

## PR 2: Platform reads and displays persisted tool calls

Repository: `parallel-agent-platform`

Branch suggestion: `codex/read-tool-call-rows`

### Scope

- Update the chat/message fetch query to include related `tool_call` rows for
  each assistant message.
- Parse `tool_call.input` and `tool_call.output` JSON strings defensively for
  display. Bad JSON should show as raw text, not break the transcript.
- Prefer first-class `tool_call` rows over `message.metadata.tool_calls` when
  both are present.
- Display tool-call status, tool name, input summary, and output/error summary
  in the chat transcript.
- Add a transcript test fixture containing a message with related tool calls.

### Platform files to inspect

Exact filenames need confirmation in the platform repo, but likely areas:

- API route/service that reads `message` rows for a session or agent
- Supabase generated types and query helpers
- chat transcript components that currently render assistant metadata/tool
  events

If platform generated schema does not include `tool_call`, run the platform's
schema sync from the canonical DB schema after the runtime PR lands.

## PR 3: Full tool replay from persisted rows

Repository: `parallel-agent-runtime`

Branch suggestion: `codex/tool-call-history-replay`

### Scope

- Extend `MessageLog.list_agent_messages/2` or add a dedicated query that can
  fetch messages with their related `tool_call` rows.
- Update `MessageHistory.fetch/2` to reconstruct valid provider history only
  when both sides exist:
  - assistant message with `tool_calls`
  - matching `tool` role messages with `tool_call_id` and output content
- Drop incomplete pairs. A model request with an assistant tool call and no
  matching tool result is invalid for OpenAI-compatible chat.
- Add token/window safeguards before replaying large tool outputs.

This should not be bundled into PR1. Writing rows is the prerequisite; replay
semantics are a separate behavior change with higher model-regression risk.

## DB and schema notes

- Do not add Supabase migrations in this repo.
- If `tool_call.input` / `tool_call.output` need to become JSONB, add the
  migration in `harper-server`, merge it there, then run:

```bash
pnpm run supabase:schema:sync
```

- The runtime already includes `tool_call` in `BRIDGE_TABLES`, so schema sync
  should keep `supabase/generated/types.ts`,
  `supabase/generated/postgrest-schema.json`, and
  `apps/orchestrator/priv/generated/postgrest-schema.json` aligned.

## Open questions

1. Should `tool_call.tool_id` be required for first-class runtime tools, or is
   nullable acceptable for provider/Codex dynamic tools?
2. Should rows be written for `tool_call_started`, or only terminal
   completed/failed calls? Recommendation: terminal rows only for PR1.
3. Should `tool_call.output` include full command output, or should large
   outputs be truncated with a pointer to runtime logs? Recommendation:
   truncate in PR1 if payload exceeds a conservative byte limit, and include
   `"truncated": true` in the encoded output.
