# Scheduled Task Helper Scope

Status: scoping note, 2026-05-14

Companion scopes:

- `parallel-agent-platform/docs/active/manager-agent-scheduled-work-scope.md`
- `parallel-agent-runtime/docs/scheduled-task-runtime-scope.md`
- `harper-server/docs/scheduled-task-schema-scope.md`

## Decision

No `local-runtime-helper` scheduler should be added for v1 scheduled tasks.

Scheduled tasks are persisted in Harper/Supabase and executed by the
`parallel-agent-runtime` orchestrator. The runtime posts scheduled instructions
through `ChatGateway` with message metadata:

```json
{
  "source": "scheduled_task",
  "kind": "scheduled_agent_message"
}
```

The helper should continue to handle the normal local relay/runtime path. It
does not need to know how to poll `scheduled_task`, compute cron schedules, or
claim scheduled runs.

## Why

Adding a helper-side scheduler would create split-brain delivery:

- cloud runtime could deliver a scheduled message
- local helper could also deliver the same scheduled message
- offline helper behavior would diverge from server-side run history

The database/run-history idempotency contract belongs in the runtime worker,
not on each user machine.

## Possible Future Helper Work

Only revisit this repo if a later product requirement needs:

- desktop-native notifications for scheduled tasks
- local-only schedules while offline
- helper UI for upcoming scheduled messages
- explicit relay metadata rendering for scheduled messages

If that happens, keep the helper as a display/notification participant. Do not
make it the source of truth for schedule execution.

## Acceptance Criteria For V1

- No helper-side cron loop is introduced.
- No helper-side `scheduled_task` polling is introduced.
- If scheduled messages traverse local relay sessions, metadata is passed
  through unchanged.
