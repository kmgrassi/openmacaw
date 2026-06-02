# Scheduled Task Runtime Scope

Status: scoping draft, 2026-05-14

Companion scopes:

- `parallel-agent-platform/docs/active/manager-agent-scheduled-work-scope.md`
- `harper-server/docs/scheduled-task-schema-scope.md`
- `local-runtime-helper/docs/scheduled-task-helper-scope.md`

## Goal

Run persisted `scheduled_task` rows by delivering their free-text
`instructions` to an agent at the configured time.

The runtime owns the clock loop and delivery. The database owns schedule state.
The platform owns API/UI/contracts. The local runtime helper should not get a
second scheduler in v1.

## Runtime Ownership

Add a new worker separate from `SymphonyElixir.Manager.Scheduler`.

`Manager.Scheduler` remains a due-`work_items` poller. Scheduled tasks are
general clock-driven agent messages and should not be forced through
`work_items`. If a work item triggered a scheduled task, runtime should carry
that work item id as provenance metadata only.

Candidate modules:

- `SymphonyElixir.ScheduledTask.Scheduler`
- `SymphonyElixir.ScheduledTask.Supervisor`
- `SymphonyElixir.ScheduledTask.Repository`
- `SymphonyElixir.ScheduledTask.NextRun`
- `SymphonyElixir.ScheduledTask.Delivery`

## Data Contract

Runtime reads `scheduled_task` rows with at least:

- `id`
- `workspace_id`
- `agent_id`
- `source_work_item_id`
- `instructions`
- `enabled`
- `schedule`
- `timezone`
- `next_run_at`
- `delivery`
- `metadata`

Runtime writes `scheduled_task_run` rows with:

- `scheduled_task_id`
- `scheduled_for`
- `status`
- `started_at`
- `finished_at`
- `run_id` or `message_id` for direct message delivery
- `source_work_item_id` when present on the scheduled task
- `error`

Use a unique key on `(scheduled_task_id, scheduled_for)` so multiple runtime
instances cannot deliver the same occurrence twice.

## Delivery Kind

V1 delivery kind:

```json
{ "kind": "scheduled_agent_message" }
```

Runtime must validate this explicitly. Do not treat arbitrary delivery JSON as
executable instructions.

When delivering through `ChatGateway.post_message`, attach metadata:

```json
{
  "source": "scheduled_task",
  "kind": "scheduled_agent_message",
  "scheduled_task_id": "...",
  "scheduled_task_run_id": "...",
  "scheduled_for": "2026-05-18T14:00:00Z"
}
```

This lets message readers distinguish scheduled messages from user chat,
manager due-work injections, and direct tool output.

## Clock Loop

Suggested flow:

```text
ScheduledTask.Scheduler tick
  -> query enabled rows where next_run_at <= now()
  -> for each due row:
       insert scheduled_task_run(status="claimed")
       if unique conflict: skip
       validate delivery.kind
       post instructions through ChatGateway
       update run status delivered/failed
       update scheduled_task last_run_* and next_run_at or retry state
```

Poll cadence can start at 30 to 60 seconds. Use jitter on startup to avoid all
instances polling at the same instant.

## Failure and Retry Semantics

Do not leave `next_run_at` pinned to a failed occurrence. A failed
`scheduled_task_run` still occupies the unique `(scheduled_task_id,
scheduled_for)` claim, so repeatedly polling the same overdue `next_run_at`
would only hit the same unique conflict and permanently stall the schedule.

V1 should choose one deterministic policy and encode it in tests. Recommended
policy:

1. Record the run as `failed`, including `error`, `finished_at`, and
   `attempt_count`.
2. If the failure is retryable and retry budget remains, set
   `scheduled_task.next_run_at` to a retry timestamp in the near future and
   keep the same logical occurrence in metadata, for example
   `retry_of_scheduled_for`.
3. If retry budget is exhausted, or the failure is not retryable, set
   `scheduled_task.next_run_at` to the next schedule occurrence after
   `scheduled_for`.
4. Always update `scheduled_task.last_run_status` and `last_error`.

For v1, retry budget can be small and fixed, for example three attempts with
exponential backoff capped at 15 minutes. If retry policy is not implemented in
the first slice, the scheduler must still advance to the next occurrence after
recording the failure. Manual repair should not be required for transient
`ChatGateway` failures.

## Next-Run Calculation

The runtime must not drift from platform schedule calculation.

Options:

1. Implement the same schedule algorithm in TypeScript and Elixir and cover it
   with shared fixtures.
2. Let platform compute `next_run_at` for create/update, and runtime only
   computes the next occurrence after a delivery using a shared fixture suite.
3. Move next-run calculation into a Postgres function.

Recommendation for first implementation: option 2. Platform computes
`next_run_at` when a schedule is created or updated; runtime computes the next
occurrence after each terminal delivery attempt, whether delivered or failed.
If retry is enabled, runtime may first compute a retry timestamp according to
the retry policy; once retry budget is exhausted, it computes the next schedule
occurrence. Both platform and runtime must use shared JSON fixtures checked
into platform and runtime. Keep schedule shapes small:

- `at`
- `every` with `hour`, `day`, `week`
- optional `at` time for day/week
- `cron` only if we commit to a parser dependency in runtime

Do not start with a Postgres function. SQL timezone/cron behavior is harder to
version and test than small application-level schedule calculators with shared
fixtures.

## Tool Surface

Add generic runtime tools. These should be grantable to manager, planning,
coding, and custom agents. Do not hard-code manager-only access in the runtime
tool implementation.

- `scheduled_task.create`
- `scheduled_task.read`
- `scheduled_task.update`
- `scheduled_task.list`
- `scheduled_task.delete`
- `scheduled_task.run_now` (optional v1)

Add them to:

- `SymphonyElixir.ToolRegistry`
- any appropriate generic/planner/manager bundles while final grant wiring
  catches up
- runtime tool tests
- platform tool-grant catalog/default grants for planning, coding, manager, and
  custom agents where appropriate

The tool names are schema/API names and should not vary by repo.

### `scheduled_task.create`

Creates a new schedule. It validates schedule JSON, delivery kind, target
agent/workspace scope, and computes or accepts the API-computed `next_run_at`
according to the shared contract.

### `scheduled_task.read`

Reads one schedule by id. Agents should use this before editing or deleting a
specific schedule.

### `scheduled_task.update`

Updates an existing schedule by `scheduledTaskId`. It must not create a new row
when the id is missing or unknown.

### `scheduled_task.list`

Lists schedules visible to the current caller scope. Agents need this before
editing or deleting existing schedules.

### `scheduled_task.delete`

Soft-deletes/disables a schedule and preserves run history.

### `scheduled_task.run_now`

Optional first cut. Creates a `scheduled_task_run` immediately and delivers the
message once without waiting for `next_run_at`.

## Logging

Add structured runtime log events:

- `scheduled_task_poll_started`
- `scheduled_task_poll_finished`
- `scheduled_task_run_claimed`
- `scheduled_task_message_delivered`
- `scheduled_task_run_failed`
- `scheduled_task_run_skipped`

Include `workspace_id`, `agent_id`, `scheduled_task_id`,
`scheduled_task_run_id`, `scheduled_for`, `source_work_item_id`, and `trace_id`
where available.

## Acceptance Criteria

- A due `scheduled_task` with `delivery.kind = "scheduled_agent_message"`
  posts exactly one agent message through `ChatGateway`.
- Two runtime instances cannot deliver the same `(scheduled_task_id,
  scheduled_for)` occurrence twice.
- Message metadata includes `source = "scheduled_task"` and
  `kind = "scheduled_agent_message"`.
- Failed delivery records run status and `scheduled_task.last_error`, then
  either schedules a bounded retry or advances `next_run_at` to the next
  occurrence so the schedule cannot stall on a claimed failed run.
- If `workspace_id` is null, runtime resolves workspace from `agent_id` when
  safe; if it cannot resolve exactly one workspace, it fails the run as
  `missing_workspace_context`.
- No code path adds a second scheduler to `local-runtime-helper`.
- Runtime exposes generic scheduled-task tools through `ToolRegistry`, and the
  tools enforce grants/workspace scope rather than assuming manager-only use.

## Out of Scope

- Work-item delivery mode.
- Local desktop-native cron.
- UI management.
- Replacing `Manager.Scheduler` or changing due-`work_items` behavior.
