# Manager Chat Entrypoint Unification Scope

## Goal

Collapse the manager scheduler's bespoke `Manager.run_batch/3` entrypoint into
the same chat path that browser users already use. After this refactor, both
the scheduler and a human triggering an ad-hoc manager run post a structured
message to the agent through one entrypoint. The work-item-to-text formatting
moves into a reusable module so other callers can render structured records
(work items, plans, archived tasks, etc.) into chat-ready context.

## Relationship to Existing Scopes

This builds on
[manager-message-persistence-scope.md](manager-message-persistence-scope.md),
which unifies persistence so manager turns land in `session_thread` /
`message` via `MessageLog`. That doc keeps the scheduler calling
`Manager.run_batch/3`. This doc is the next step: with persistence already
shared, the bespoke entrypoint becomes redundant.

If the persistence work has not landed yet, this PR set assumes it is
sequenced after PR 1 of that scope (manager turns persisted via shared
`MessageLog` adapter).

## Current State

Two parallel paths.

Regular chat (`apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex`):

```text
chat.send
  -> SessionStore.append_user_message
  -> MessageLog.record_user_message
  -> SessionStore.start_run
  -> Gateway.ChatRunner.run(agent, scope, prompt, run_id, owner_pid)
```

Manager scheduler (`apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`):

```text
tick
  -> query due work_items
  -> Jason.encode!(%{"due_tasks" => Enum.map(...)})  # in Manager.run_batch/3
  -> MessageRecorder.start_run
  -> Runner.Manager.run_turn(session, due_tasks_json, batch_work_item)
  -> MessageRecorder.finalize_run
```

The two paths differ in three substantive ways:

1. **Message construction.** Chat receives a raw user string. Manager builds
   a JSON payload from `WorkItem` records inside `Manager.run_batch/3`
   ([manager.ex:33-36](../apps/orchestrator/lib/symphony_elixir/manager.ex)).
2. **Persistence adapter.** Chat uses `MessageLog`. Manager uses
   `Manager.MessageRecorder`. (Persistence scope unifies these.)
3. **Runner dispatch.** Chat goes through `Gateway.ChatRunner` which reads
   agent type and execution profile. Manager goes directly through a
   `runner.run_turn/3` resolved on the session.

The first two collapse cleanly. The third is the only judgment call: should
`ChatRunner` learn to dispatch to manager runners, or should manager keep a
distinct dispatch path that is invoked by the same higher-level entrypoint?

## Design Principle

The scheduler is a client of the chat path, not a sibling of it. The
scheduler's job becomes:

1. Select due work items.
2. Format them into a chat message via a reusable formatter.
3. Post the message through the same path a browser user would, with metadata
   identifying the trigger.

The runtime treats scheduler-originated messages and human-originated messages
identically below the entrypoint. Differences are encoded in message metadata,
not in branching code paths.

## Proposed Runtime Design

### 1. Extract a structured-context formatter

New module: `SymphonyElixir.StructuredContext` (or
`SymphonyElixir.ChatContext.Formatter`). Pure functions, no side effects.

Responsibilities:

- Render a list of records into a chat-ready payload (string body plus
  structured metadata).
- Support multiple record kinds: work items (due, archived, by-id), plans,
  arbitrary maps.
- Return both the body string the model sees and the metadata that should
  ride on the message row.

Example surface:

```elixir
@spec format_work_items([WorkItem.t()], keyword()) ::
  {body :: String.t(), metadata :: map()}
def format_work_items(work_items, opts \\ [])
# opts: :kind ("due_tasks", "archived_tasks", "selected"), :note (optional preface)
```

The current `Manager.work_item_payload/1` and the JSON wrapping move here.
Existing manager callers get the same JSON body by passing
`kind: "due_tasks"`. Future callers (ad-hoc human queries, planner context
hand-off, archived task review) call the same module with different opts.

This is the piece the user specifically asked to be reusable — anything that
needs to render structured records into a chat turn calls one module.

### 2. Define a single entrypoint that accepts structured context

New function (location TBD — likely a new `SymphonyElixir.ChatGateway`
module that both `GatewaySocket` and `Manager.Scheduler` call):

```elixir
@spec post_message(scope :: map(), body :: String.t(), opts :: keyword()) ::
  {:ok, run_id :: String.t()} | {:error, term()}
def post_message(scope, body, opts \\ [])
# opts: :run_id, :metadata, :owner_pid, :on_message
```

This function does what `chat.send` does today minus the websocket framing:
session append, user-message persist, run start, runner dispatch. Both
`GatewaySocket.handle_request("chat.send", ...)` and
`Manager.Scheduler.run_manager_batch/3` call it.

Metadata is the carrier for "this came from the scheduler":

```json
{
  "source": "manager_scheduler",
  "kind": "due_tasks",
  "work_item_ids": ["..."],
  "scheduled_at": "...",
  "run_id": "..."
}
```

(Same metadata shape used by the persistence-scope doc, so the platform UI
can already filter on it.)

### 3. Reduce the scheduler to a client

`Manager.Scheduler.run_manager_batch/3` becomes:

```elixir
def run_manager_batch(session, due_work_items, opts) do
  scope = scope_for(session)
  {body, metadata} = StructuredContext.format_work_items(due_work_items, kind: "due_tasks")
  metadata = Map.merge(metadata, %{
    source: "manager_scheduler",
    scheduled_at: opts[:scheduled_at] || DateTime.utc_now()
  })
  ChatGateway.post_message(scope, body, metadata: metadata, run_id: opts[:run_id])
end
```

`Manager.run_batch/3` is removed. `Manager.MessageRecorder` is removed (its
work is done by the shared `MessageLog` write inside `ChatGateway.post_message`
plus runner-emitted assistant events the gateway already records).

### 4. Runner dispatch

`Gateway.ChatRunner.run/5` already reads `agent.type` and dispatches to
Planner / Codex / LocalModelCoding. Add a `manager` branch that calls
`Runner.Manager.run_turn/3` with the same args ChatRunner uses for other
runners.

The existing `Runner.Manager.requires_workspace?/0 == false` keeps it
workspace-optional. The session that ChatRunner constructs needs to carry
manager-specific config (tool policy, system prompt). Verify this by
inspecting how `Runner.Manager` is configured today via `SessionResolver`
and either fold that into ChatRunner's session construction or have
ChatRunner delegate manager-session resolution to the existing resolver.

## Repos Affected

| Repo | Changes |
|---|---|
| `parallel-agent-runtime` | All implementation work. |
| `parallel-agent-platform` | None for this refactor. Optional follow-up: a "trigger manager run" UI that posts via existing `chat.send`. |
| `harper-server` | None. No schema changes. |
| `local-runtime-helper` | None. |

## Implementation Plan

### PR 1: Extract `StructuredContext` formatter

- New module with `format_work_items/2`.
- `Manager.run_batch/3` calls into it instead of inlining the JSON build.
- No behavior change. Pure refactor with unit tests covering each `:kind`.

Files:
- `apps/orchestrator/lib/symphony_elixir/structured_context.ex` (new)
- `apps/orchestrator/lib/symphony_elixir/manager.ex` (delegate to formatter)
- `apps/orchestrator/test/symphony_elixir/structured_context_test.exs` (new)

### PR 2: Add `ChatGateway.post_message` and route `chat.send` through it

- New module wraps the body of `GatewaySocket.handle_request("chat.send", ...)`.
- `GatewaySocket` becomes a thin transport adapter that calls
  `ChatGateway.post_message`.
- `metadata` opt is plumbed through to `MessageLog.record_user_message`.
- Behavior parity for browser chat. Add tests proving websocket flow still
  works end-to-end.

Files:
- `apps/orchestrator/lib/symphony_elixir/chat_gateway.ex` (new)
- `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex`
- `apps/orchestrator/lib/symphony_elixir/message_log.ex` (metadata plumbing)
- `apps/orchestrator/test/symphony_elixir/chat_gateway_test.exs` (new)

### PR 3: Teach `Gateway.ChatRunner` to dispatch to manager

- Add manager branch in ChatRunner.
- Reuse `Manager.SessionResolver` (or move its body into ChatRunner's
  session-construction path).
- Tests: posting a message to a manager-typed agent via `ChatGateway`
  reaches `Runner.Manager.run_turn/3`.

Files:
- `apps/orchestrator/lib/symphony_elixir/gateway/chat_runner.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/session_resolver.ex`
- `apps/orchestrator/test/symphony_elixir/gateway/chat_runner_test.exs`

### PR 4: Switch the scheduler to `ChatGateway.post_message` and delete the bespoke path

- `Manager.Scheduler.run_manager_batch/3` calls
  `StructuredContext.format_work_items` then `ChatGateway.post_message`.
- Delete `Manager.run_batch/3` and `Manager.MessageRecorder` (its work is
  done by the shared `MessageLog` write inside `ChatGateway`).
- Update existing scheduler tests; add an end-to-end test that proves a
  scheduler tick produces the same persisted message rows as before.

Files:
- `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`
- `apps/orchestrator/lib/symphony_elixir/manager.ex` (delete or shrink)
- `apps/orchestrator/lib/symphony_elixir/manager/message_recorder.ex` (delete)
- `apps/orchestrator/test/symphony_elixir/manager/*_test.exs`

Per CLAUDE.md, no backwards-compat shims: delete the old entrypoint in the
same PR set rather than leaving it as a deprecated wrapper.

## Acceptance Criteria

- A scheduler tick with N due work items produces the same `session_thread`
  and `message` rows it produces today, with identical metadata fields.
- The body of the user message is generated by `StructuredContext`, not by
  inline code in `Manager.*`.
- Posting a message to a manager-typed agent via `chat.send` from the
  browser reaches `Runner.Manager.run_turn/3` and produces an assistant
  message in the same thread.
- `Manager.run_batch/3` and `Manager.MessageRecorder` no longer exist in
  the codebase.
- `mix compile --warnings-as-errors` and `mix test` both pass.
- The "Browser Login And Planner Work Item Smoke" runbook in CLAUDE.md
  still passes; an analogous manager smoke is added to docs.

## Non-Goals

- Adding a UI trigger for ad-hoc manager runs. (Follow-up; out of scope.)
- Changing the manager system prompt. (Separate decision; the prompt's
  "due tasks" framing stays until a caller actually posts non-due context.)
- Changing how due work items are selected.
- Adding new tool kinds or changing tool execution.
- Streaming manager deltas to the browser when no browser is connected.
- Schema changes (no new tables, no new enum values).

## Open Questions

1. **Runner dispatch ownership.** Should `Gateway.ChatRunner` know about
   manager directly, or should `ChatGateway.post_message` dispatch via a
   per-agent-type routing table that ChatRunner is one entry in?
   Recommendation: extend ChatRunner — the routing is already there.
2. **Idempotency.** `chat.send` supports an idempotency key via `run_id`.
   The scheduler already generates a `run_id` per batch. Confirm the
   end-to-end idempotency story still holds when both flow through one path.
3. **Empty batches.** Today `Manager.run_batch(session, [], _opts)` returns
   a zero result without persisting anything. Preserve this in the
   scheduler's call site (skip `post_message` when no due items).
4. **Future formatter kinds.** Should `StructuredContext` live in
   `apps/orchestrator` or in a shared library? Recommendation: keep in the
   orchestrator until a second consumer appears.
5. **Naming.** `ChatGateway` vs. `MessageGateway` vs. `Conversation`. The
   chosen name should make it obvious that the websocket layer and the
   scheduler both call into it.
