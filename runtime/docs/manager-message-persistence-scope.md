# Manager Message Persistence Scope

## Goal

Make manager-agent turns visible in the same durable chat history as regular
agent turns, whether the turn is initiated by the scheduler or by a browser
chat message.

When the manager scheduler wakes, selects due work items, sends the due-task
payload to the manager model, receives assistant output, and executes manager
tools, that activity should be persisted to `session_thread` and `message`.
The platform chat UI should be able to show the manager ping as a normal
manager-agent conversation, and the same transcript should accept interactive
chat turns from the browser.

## Current State

Regular chat turns and manager turns use different orchestration entrypoints.

Regular chat:

```text
GatewaySocket chat.send
  -> SessionStore append/start_run
  -> MessageLog record_user_message
  -> Gateway.ChatRunner
  -> runner on_message callback
  -> GatewaySocket receives runner event
  -> MessageLog record_assistant_message
```

Manager scheduler:

```text
Manager.Scheduler tick
  -> query due work_items
  -> Manager.run_batch(session, due_items)
  -> Runner.Manager.run_turn(session, due_tasks_json, batch_work_item)
```

The manager path is autonomous, so it correctly does not require a websocket.
However, it currently bypasses the gateway wrapper that creates message-log
threads and writes user/assistant messages. `Runner.Manager` already accepts an
`on_message` callback and emits notification, tool, and turn-completed events;
the missing piece is wiring those events to a persistence adapter in the
scheduler-created session and making sure interactive browser chat uses the same
message store path instead of a read-only fork.

## Design Principle

The manager should keep its autonomous scheduler entrypoint, but it should reuse
the same message persistence model as regular agents.

Do not create a manager-only transcript table. Use the existing `session_thread`
and `message` tables through `SymphonyElixir.MessageLog`. The distinction
between a human chat turn and an autonomous manager tick belongs in message
metadata, not in a separate storage path or a read-only transcript view.

## Proposed Runtime Design

### 1. Add a manager transcript module

Add `SymphonyElixir.Manager.MessageRecorder` as a small adapter around
`SymphonyElixir.MessageLog`.

Responsibilities:

- derive a stable manager session scope
- upsert the manager `session_thread`
- record the due-task JSON payload as a user/input message
- record assistant output on manager completion
- record manager tool events in message metadata
- record manager failures as assistant/runtime error messages
- support browser-originated manager chat turns using the same recorder path

Suggested scope:

```elixir
%{
  agent_id: manager_agent_id,
  workspace_id: workspace_id,
  user_id: manager_user_id,
  session_key: "manager:#{workspace_id}:#{manager_agent_id}"
}
```

If the manager agent has a creator/user owner in the agent row, use that user
id. If no user owner is available, add an explicit service-user strategy before
writing messages; do not insert null `user_id` values if the live schema
requires a user.

### 2. Attach persistence during session resolution

`Manager.SessionResolver.resolve/2` should enrich the manager runner config with
an `on_message` callback before `Runner.Manager.start_session/2` is called.

The callback should be workspace and run aware:

```elixir
on_message = fn event ->
  Manager.MessageRecorder.record_event(scope, run_id, event)
end
```

The scheduler owns the run lifecycle, so it should generate a `run_id` for each
non-empty batch and pass it into `Manager.run_batch/3`. The manager runner
should not invent persistence identity internally.

### 3. Persist the input payload before the model call

`Manager.run_batch/3` already builds the JSON-shaped payload:

```json
{"due_tasks":[...]}
```

Before calling `runner.run_turn/3`, persist that exact payload as the manager
turn input. The message can use role `user` if the current DB enum only supports
regular chat roles. Put the autonomous semantics in metadata:

```json
{
  "source": "manager_scheduler",
  "kind": "due_tasks",
  "work_item_ids": ["..."],
  "scheduled_at": "..."
}
```

If the schema already supports `system`, `tool`, or `runtime` roles, use the
existing enum values consistently with `MessageLog`. Do not introduce a new enum
value in this PR unless the live DB requires it.

The browser-facing manager chat flow should persist user turns the same way
regular chat does, so the transcript remains one continuous conversation rather
than a scheduler-only log plus a separate interactive thread.

### 4. Persist assistant output from manager events

`Runner.Manager` emits assistant output through `:notification` events carrying
`codex/event/agent_message_delta`. It also emits `:turn_completed` with usage.

For persistence:

- accumulate assistant deltas per `run_id`
- write one final assistant message when `:turn_completed` arrives
- include usage, response id, provider, model, runner kind, and due work item ids
  in metadata
- if a manager turn fails before completion, write an assistant error message
  with error metadata

Avoid writing one database row per token/delta. The chat UI should display the
final manager message as a readable turn.

### 5. Persist tool calls as metadata first

Manager tool events should be visible, but they do not need first-class chat
rows in the first implementation.

Recommended MVP:

- collect `:tool_call_completed` and `:tool_call_failed` events during the turn
- attach a compact `tool_calls` array to the final assistant message metadata
- include tool name, call id, success/failure, retryable flag, and error code

Future work can add separate tool-role message rows if the platform UI needs a
timeline view.

### 6. Keep writes best-effort

Manager scheduling should not stop permanently because message persistence is
temporarily unavailable.

Behavior:

- log failed `MessageLog` writes with workspace id, manager agent id, and run id
- continue the manager turn when the input-message insert fails
- continue scheduler ticks when assistant-message insert fails
- surface persistence write failures in runtime logs, not as manager model
  failures

## Platform Expectations

The platform should not need a manager-specific transcript endpoint or a
read-only manager transcript mode.

It should be able to query messages for the manager agent using the same
session/message read path used for other agents. The UI can label messages as
manager pings by checking metadata:

```json
{
  "source": "manager_scheduler",
  "kind": "due_tasks"
}
```

If the existing session list excludes manager agents, that filter should be
updated in the platform repo after runtime writes are in place.

## Implementation Plan

### PR 1: Persist manager turns

Files likely touched:

- `apps/orchestrator/lib/symphony_elixir/manager.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/session_resolver.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/message_recorder.ex` new
- `apps/orchestrator/lib/symphony_elixir/runner/manager.ex`
- `apps/orchestrator/test/symphony_elixir/manager/*_test.exs`

Expected changes:

- generate a stable `run_id` for non-empty manager batches
- record the due-task payload before model execution
- pass an `on_message` callback into the manager runner session
- accumulate output/tool events and write the final assistant message
- add tests proving manager turns write user and assistant messages through a
  stubbed `message_log_adapter`

### PR 2: Allow browser chat through the same transcript

Files likely touched:

- `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex`
- `apps/orchestrator/lib/symphony_elixir/launcher/runtime_proxy.ex`
- `apps/orchestrator/lib/symphony_elixir/message_log.ex`
- platform chat routing and manager-specific session selection tests

Expected changes:

- make browser-originated manager chat use the same durable transcript path
- ensure manager messages remain readable through the shared session/message
  lookup
- avoid a read-only manager fork in the platform chat flow
- keep the scheduler-backed persistence path compatible with interactive chat

### PR 3: Platform visibility follow-up

Files likely touched in `parallel-agent-platform`:

- session/message queries that hide manager agents
- dashboard chat/session components, if they special-case agent types
- manager status UI, optionally linking to the manager transcript

This should be a follow-up after the runtime writes are merged, unless the
platform already reads manager-agent sessions without filtering.

## Acceptance Criteria

- A scheduler tick with due work items creates or reuses a manager session
  thread.
- The due-task JSON payload is persisted as a message with manager scheduler
  metadata.
- The manager model response is persisted as an assistant message.
- Tool calls and usage are included in assistant message metadata.
- A failed manager turn writes an error message instead of silently disappearing.
- Browser-originated manager chat turns use the same durable transcript.
- Existing websocket chat message persistence continues to work unchanged.
- Manager scheduling remains best-effort with respect to message-log failures.

## Non-Goals

- adding new DB tables
- changing how due work items are selected
- changing manager tool behavior
- showing streaming manager deltas live in the browser when no browser is
  connected
- implementing a new platform transcript UI in the runtime PR

## Open Questions

1. Which user id should own autonomous manager messages when there is no active
   browser user?
2. Should tool calls become separate `message` rows once the UI has a timeline
   component?
3. Should every scheduler tick create a message, or only ticks with non-empty
   due work item batches? Recommendation: only non-empty batches.
4. Should manager transcript session keys be one long-lived thread per
   workspace or one thread per manager run? Recommendation: one long-lived
   thread per workspace manager agent so the UI shows a continuous manager
   history.
