# Manager-Agent Scheduled Work Scope

Status: scoping draft, 2026-05-14

Repos involved and PR ownership:

- `harper-server`: schema migration for `scheduled_task` and
  `scheduled_task_run`.
- `parallel-agent-platform`: contracts, API, UI, and manager-tool grant
  defaults.
- `parallel-agent-runtime`: clock worker, run claiming, `ChatGateway`
  delivery, and runtime scheduled-task tools.
- `local-runtime-helper`: no v1 PR expected. Scheduled messages enter through
  the runtime `ChatGateway`; the helper only needs work later if local
  desktop-native scheduling or local notification delivery becomes a product
  requirement.

## Goal

Let a user tell the manager agent something like:

- "Every hour, check stalled PR work and move anything blocked forward."
- "Every day at 9am, review open work items and summarize what needs me."
- "Every three weeks, create a work item to audit our local runtime setup."

and have the system persist that instruction, wake at the right time, and
deliver the free-text instruction into the target agent.

The important distinction: the manager scheduler exists today, but it is a
due-work-item poller, not a general recurring-instruction engine. Scheduled
tasks should send text directly to an agent. They should only reference a work
item when that work item is the source/provenance of the schedule.

## Existing Inventory

### `work_items` due-polling primitives

`harper-server` migration
`supabase/migrations/20260425150000_manager_agent_prereq_tables.sql` adds:

- `work_items.next_poll_at`
- `work_items.last_polled_at`
- `work_items.poll_cadence_seconds`
- `work_items.manager_runner_id`
- `idx_work_items_due_for_manager`

The comments describe the intended manager hot path:

```text
where workspace_id = ? and state in (...) and next_poll_at <= now()
```

Runtime currently implements that in
`apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`:

- `due_query/4` filters by workspace, manager runner, state,
  non-null `next_poll_at`, and due timestamp.
- `poll_due_work_items/3` loads `SchedulerConfig.due_task_query/2`,
  queries due rows, and passes non-empty batches to `ChatGateway.post_message`.
- `run_manager_batch/3` formats those rows as `due_tasks` and posts a normal
  manager-agent message with metadata `source: "manager_scheduler"`.

What is missing:

- The scheduler does not itself advance `next_poll_at` after a run.
- `poll_cadence_seconds` exists on rows, but the scheduler does not currently
  use it to implement recurrence.
- This supports "run this existing work item at/after a time"; it does not
  support "create a new occurrence every N intervals."

### Manager scheduler config

Platform exposes manager scheduler config via:

- `GET /api/agents/:agentId/scheduler-config`
- `PUT /api/agents/:agentId/scheduler-config`

Those routes call `apps/api/src/services/manager-agent-config.ts`, which
stores:

- `cadenceMs`
- `dueTaskQuery.states`
- `dueTaskQuery.planIds`

in `gateway_config.config_json.runners.manager`.

Runtime reads the same shape through
`apps/orchestrator/lib/symphony_elixir/manager/scheduler_config.ex`.

This controls how often the manager polls and which work-item states/plans it
considers due. It is not a user-facing schedule/cron system.

### `agent_heartbeat_config`

`harper-server` migration
`supabase/migrations/20260302061200_create_agent_heartbeat_config.sql` creates
a better scheduler-owned table:

- `workspace_id`
- `agent_id`
- `enabled`
- `heartbeat_prompt`
- `tasks_json`
- `quiet_hours_json`
- `policy_json`
- unique `(workspace_id, agent_id)`

The runtime scope in
`parallel-agent-runtime/docs/manager-as-regular-agent-runtime-scope.md`
already identifies this as the right replacement for scheduler-only fields.
It maps:

- cadence to `policy_json.cadence_ms`
- due-work filters to `tasks_json: [{ kind: "due_work_items", filter: ... }]`
- custom scheduled prompt text to `heartbeat_prompt`

Current gap: runtime still reads `gateway_config.runners.manager`, not this
table, and platform does not write this table.

### `scheduled_task`

`harper-server` migration
`supabase/migrations/20260122120000_create_scheduled_task_table.sql` creates:

- `agent_id`
- `cron_schedule`
- `instructions`
- `job_id`
- `next_interval`
- `start_time`
- active/completed/follow-up flags

This is the table the user remembered. In current code it does not appear to
power the manager runtime. The only `schedule` route in Harper server is
`/schedule/run`, whose service is a placeholder: `handleScheduledJobs()` logs
"Scheduled jobs triggered" and does not query `scheduled_task`.

Recommendation: evolve this table instead of introducing a second scheduling
table. It needs workspace scoping, typed schedule/delivery state, and run
history. It should not be forced into the current manager due-work-item
contract.

### `openclaw_cron_job`

`harper-server` migration
`supabase/migrations/20260304130000_create_openclaw_cron_job.sql` creates a
DB-backed cron model with:

- `schedule` JSON (`at`, `every`, `cron`)
- `payload` JSON
- `delivery` JSON
- `state.nextRunAtMs`
- workspace/user/agent scope

This is a real cron table, but it belongs to OpenClaw cron delivery. It is not
wired into the platform manager scheduler or `work_items` flow.

Recommendation: use it as design prior art for schedule JSON shape, not as the
manager-agent product table.

### Existing agent tools

Runtime already has relevant tools:

- Planner bundle includes `task.create`, `task.update`, and `task.schedule`.
  `task.schedule` writes `work_items.next_poll_at` and optional
  `poll_cadence_seconds`, and logs `work_item.timing_updated`.
- Manager bundle includes `git.run` and the `scheduled_task.*` CRUD tools.
  Older manager-specific artifact tools are deprecated and should not be
  granted by platform defaults.
- Shared snooze tooling updates `next_poll_at`, but intentionally defers an
  existing work item; it is not recurrence.

Current gap: agents do not have first-class scheduled-task tools that can
persist "do this every hour/day/three weeks" from natural language.

## Product Model

There are two different user intents that should not be collapsed:

### 1. Defer an existing work item

Example: "Have the manager look at this tomorrow morning."

Use existing `work_items.next_poll_at`. The platform and runtime already have
most of this through `task.schedule` and snooze/wake.

### 2. Create a recurring scheduled instruction

Example: "Every three weeks, audit our runtime setup."

This needs a persistent `scheduled_task` row. Each firing should deliver a
scheduled agent message:

1. **Scheduled agent message**: post the scheduled free-text instructions
   through `ChatGateway` to the configured `agent_id`.

Do not create a `work_items` row for a free-text scheduled task. The existing
manager work-item scheduler only passes already-existing due `work_items` rows
into the manager; it does not create work-item rows as part of delivery.

If a scheduled task was created from a work item, store that work item as
provenance on the scheduled task/run metadata. That preserves traceability
without making work items part of the scheduled-message execution path.

## Proposed Data Model

Evolve the existing `scheduled_task` table rather than adding
`scheduled_work`.

Candidate columns:

```sql
id uuid primary key default gen_random_uuid(),
workspace_id uuid null references public.workspaces(id) on delete cascade,
agent_id uuid not null references public.agent(id) on delete cascade,
source_work_item_id uuid null references public.work_items(id) on delete set null,
created_by_user_id uuid null references public.user(id),

title text not null,
instructions text not null,
enabled boolean not null default true,

schedule jsonb not null,
timezone text not null default 'Etc/UTC',
next_run_at timestamptz not null,
last_run_at timestamptz null,
last_run_status text null,
last_error text null,

delivery jsonb not null default '{"kind":"scheduled_agent_message"}'::jsonb,
metadata jsonb not null default '{}'::jsonb,

created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

Schedule JSON should reuse the OpenClaw-style shape:

```json
{ "kind": "every", "interval": 1, "unit": "hour" }
{ "kind": "every", "interval": 1, "unit": "day", "at": "09:00" }
{ "kind": "every", "interval": 3, "unit": "week", "at": "09:00" }
{ "kind": "cron", "expression": "0 9 * * 1", "timezone": "America/New_York" }
{ "kind": "at", "runAt": "2026-05-15T13:00:00Z" }
```

`delivery` starts with direct agent messages:

```json
{
  "kind": "scheduled_agent_message",
  "sessionStrategy": "scheduled_task",
  "metadata": {
    "source": "scheduled_task"
  }
}
```

Each successful direct-message firing posts a message:

- `workspace_id = scheduled_task.workspace_id`
- `agent_id = scheduled_task.agent_id`
- message body = `scheduled_task.instructions`
- message metadata includes `source = "scheduled_task"`,
  `kind = "scheduled_agent_message"`, `scheduled_task_id`,
  `scheduled_task_run_id`, and `scheduled_for`
- if `source_work_item_id` is set, include it in metadata as provenance

Workspace propagation:

- If the scheduling request happens inside a workspace, persist that
  `workspace_id`.
- If the schedule is created from a work item, copy the work item's
  `workspace_id` and `id`.
- If the workspace cannot be known at schedule creation time, keep
  `workspace_id = null`.
- At runtime, if `workspace_id` is null, resolve it from `agent_id` when safe.
  If the agent cannot be resolved to one workspace, fail the run as
  `missing_workspace_context`.

## Agent Tool Surface

Add generic scheduled-task tools that can be granted to any agent type
(manager, planning, coding, or custom). These are not manager-only tools. The
tool implementation must scope writes by the caller's workspace/agent context
and enforce the same API validation as human-facing routes.

Recommended tool split:

### `scheduled_task.create`

Creates a new scheduled task.

Input:

```json
{
  "title": "Review blocked PRs",
  "instructions": "Find blocked PR-related work items and move them forward.",
  "schedule": {
    "kind": "every",
    "interval": 1,
    "unit": "hour"
  },
  "timezone": "America/New_York",
  "delivery": { "kind": "scheduled_agent_message" }
}
```

Return:

```json
{
  "scheduledTaskId": "...",
  "nextRunAt": "2026-05-14T14:00:00Z",
  "enabled": true
}
```

### `scheduled_task.read`

Reads one scheduled task by id. Agents should use this before editing or
deleting a specific schedule.

### `scheduled_task.update`

Updates an existing scheduled task by `scheduledTaskId`. It must not create a
new row when the id is missing or unknown.

### `scheduled_task.list`

Lists scheduled tasks visible to the current agent/workspace. This is needed
so an agent can safely inspect existing schedules before updating or deleting
one.

### `scheduled_task.delete`

Deletes or disables a scheduled task. Prefer soft delete/cancel in the backing
API so history remains available.

Input:

```json
{
  "scheduledTaskId": "...",
  "reason": "User asked to stop the weekly HN check."
}
```

### `scheduled_task.run_now`

Optional v1. Runs one occurrence immediately. This is useful for testing and
for "do this now and then every Monday" flows, but it can be deferred if we
want the first tool cut to be smaller.

Tool safety:

- These should be available to all default agent roles through grants, not
  limited to manager agents.
- Creating, editing, or deleting a recurring schedule is persistent behavior.
  Prompts should require clear user intent when cadence, task content, target
  agent, or cost impact is ambiguous.
- The delete tool should be owner/workspace scoped and should not hard-delete
  run history.

## Platform API Surface

Add routes parallel to work-item routes:

- `GET /api/workspaces/:workspaceId/scheduled-tasks`
- `POST /api/workspaces/:workspaceId/scheduled-tasks`
- `PUT /api/workspaces/:workspaceId/scheduled-tasks/:scheduledTaskId`
- `POST /api/workspaces/:workspaceId/scheduled-tasks/:scheduledTaskId/run-now`
- `POST /api/workspaces/:workspaceId/scheduled-tasks/:scheduledTaskId/cancel`

All routes should:

- require auth
- enforce workspace membership
- validate `agent_id` belongs to the workspace and is a manager agent for the
  first product pass
- return the normalized `nextRunAt`

The manager runtime tools can write through PostgREST directly or call a
runtime-local helper module that mirrors the platform contract. Prefer sharing
the JSON contract in `contracts/scheduled-tasks.ts` so platform and runtime do
not drift.

## Enum and Schema Updates

Call these out in the implementation PRs so the new `kind` does not become
another undocumented string.

### Harper server

- Migrate `scheduled_task.delivery` with a JSON check, or a generated
  validation helper, that accepts the v1 delivery kind:
  - `scheduled_agent_message`
- Add `scheduled_task_run.status` check values, likely:
  - `claimed`
  - `delivered`
  - `failed`
  - `skipped`
- Do not change the DB-level `work_items.source` check/enum for v1.
  Scheduled tasks do not create work items.

### Platform contracts

- Add `contracts/scheduled-tasks.ts`.
- Add `ScheduledTaskScheduleSchema` for:
  - `{ kind: "at", runAt }`
  - `{ kind: "every", interval, unit, at? }`
  - `{ kind: "cron", expression, timezone? }`
- Add `ScheduledTaskDeliverySchema` as a discriminated union:
  - `{ kind: "scheduled_agent_message", sessionStrategy?: "scheduled_task" }`
- Add `ScheduledTaskRunStatusSchema` matching the DB check.
- Keep `WORK_ITEM_SOURCES` unchanged in v1. Use `source_work_item_id` and
  scheduled-task metadata for provenance instead of creating a new work-item
  source.
- Add API request/response projections for create, update, list, cancel, and
  run-now.

### Runtime schemas and atoms

- Add runtime validation for `delivery.kind = "scheduled_agent_message"` before
  posting through `ChatGateway`.
- Ensure message metadata uses the stable string
  `kind: "scheduled_agent_message"` and `source: "scheduled_task"`.
- Add structured runtime log event names for scheduled-task lifecycle events,
  e.g. `scheduled_task_run_claimed`, `scheduled_task_message_delivered`,
  `scheduled_task_run_failed`.
- Add any new tool names to the runtime `ToolRegistry` and platform tool-grant
  catalog:
  - `scheduled_task.create`
  - `scheduled_task.read`
  - `scheduled_task.update`
  - `scheduled_task.list`
  - `scheduled_task.delete`
  - `scheduled_task.run_now` if shipped in v1
- Update default grants/templates for planning, coding, manager, and custom
  agents where appropriate. The implementation should not assume only manager
  agents can create schedules.

## Runtime Execution Flow

Add a scheduled-task worker separate from `Manager.Scheduler`:

```text
ScheduledTask.Scheduler
  -> finds rows where enabled and next_run_at <= now()
  -> claims a row/run with an advisory lock or atomic update
  -> if delivery.kind == "scheduled_agent_message":
       ChatGateway.post_message(agent, instructions, metadata)
  -> updates last_run_at, last_run_status, next_run_at
```

This keeps recurrence concerns out of `Manager.Scheduler`. That scheduler
continues to do one job: decide which `work_items` are due and inject them
into the manager chat path. Scheduled tasks are a separate clock-driven
message/work producer.

Claiming needs to be explicit. A safe pattern:

- `scheduled_task_run` table with `scheduled_task_id`, `scheduled_for`,
  `status`, `source_work_item_id`, `started_at`, `finished_at`, `error`.
- Add `message_id` or `run_id` for direct agent-message deliveries.
- unique `(scheduled_task_id, scheduled_for)` to prevent duplicate
  materialization when multiple runtime instances race.
- update `scheduled_task.next_run_at` only after the run row is created.

## Natural-Language Parsing

The model should not be asked to invent timestamps without context.

Manager prompt should include:

- current ISO time
- workspace timezone
- examples for hourly/daily/every-three-weeks schedules
- instruction to call `schedule_task` with normalized JSON

Examples:

User: "Do this every hour."

```json
{
  "schedule": { "kind": "every", "interval": 1, "unit": "hour" }
}
```

User: "Every day at 9am."

```json
{
  "schedule": { "kind": "every", "interval": 1, "unit": "day", "at": "09:00" },
  "timezone": "America/New_York"
}
```

User: "Every three weeks."

```json
{
  "schedule": { "kind": "every", "interval": 3, "unit": "week" }
}
```

For ambiguous phrases like "every morning", the manager should ask a follow-up
for the time unless a workspace default exists.

## PR Plan

### PR 1: Contracts and schema

Repo: `harper-server` + `parallel-agent-platform`.

- Migrate existing `scheduled_task` into the v1 shape:
  - add `workspace_id`
  - add `source_work_item_id`
  - add `enabled`, `schedule`, `timezone`, `next_run_at`, `last_run_at`,
    `last_run_status`, `last_error`, `delivery`, `metadata`
  - preserve or migrate old `cron_schedule`, `next_interval`, `start_time`,
    and `is_active` where feasible
- Add `scheduled_task_run`.
- Add RLS scoped to workspace membership.
- Add indexes on `(workspace_id, enabled, next_run_at)` and `(agent_id,
enabled, next_run_at)`.
- Add `contracts/scheduled-tasks.ts` with schedule JSON schemas and response
  projection.
- Keep `WORK_ITEM_SOURCES` unchanged.

Acceptance:

- Type generation includes the new tables.
- Invalid schedule JSON is rejected at the API/contract layer.

### PR 2: Platform API

Repo: `parallel-agent-platform`.

- Implement scheduled-task CRUD/run-now/cancel routes.
- Validate workspace membership and manager-agent ownership.
- Compute `nextRunAt` server-side from schedule JSON and timezone.
- Add unit tests for hourly, daily-at-time, every-three-weeks, cron, disabled,
  and cross-workspace rejection cases.

Acceptance:

- A user can create a schedule through API and see `nextRunAt`.
- Cancel keeps the row but prevents future delivery.

### PR 3: Runtime scheduler

Repo: `parallel-agent-runtime`.

- Add `ScheduledTask.Scheduler`/supervisor.
- Poll due `scheduled_task` rows.
- Create `scheduled_task_run` rows idempotently.
- For `delivery.kind = "scheduled_agent_message"`, post the free-text
  instructions to the configured agent through `ChatGateway`.
- Advance `next_run_at` using the same schedule library/algorithm as platform,
  with shared fixtures to prevent drift.

Acceptance:

- A due hourly schedule sends exactly one direct agent message in v1.
- Two scheduler instances cannot create duplicate deliveries for the same
  scheduled occurrence.
- Failed delivery records `last_error` and leaves enough state for
  retry/diagnosis.

### PR 4: Runtime scheduled-task tools

Repo: `parallel-agent-runtime`.

- Add scheduled-task tools to the runtime tool registry:
  - `scheduled_task.create`
  - `scheduled_task.read`
  - `scheduled_task.update`
  - `scheduled_task.list`
  - `scheduled_task.delete`
  - optionally `scheduled_task.run_now`
- Add prompt guidance with current time and timezone.
- Add tool tests around validation and workspace scoping.

Acceptance:

- Any granted agent can create a schedule from chat, e.g. "do X every hour."
- The created schedule sends the scheduled text on the next scheduler tick.

### PR 5: Platform grant defaults

Repo: `parallel-agent-platform`.

- Add scheduled-task tool definitions to the platform tool catalog/schema.
- Grant scheduled-task tools to default planning, coding, and manager agents.
- Ensure restricted allowlists know the tool names so unknown-tool filtering
  and policy enforcement remain deterministic.

Acceptance:

- New default agents can call `scheduled_task.create`, `scheduled_task.read`,
  `scheduled_task.update`, `scheduled_task.list`, and
  `scheduled_task.delete` when their runtime grants are synced.
- Existing grant/policy tests cover these tool names.

### PR 6: UI

Repo: `parallel-agent-platform`.

- Add scheduled-task list/detail controls in the manager or workspace settings
  surface.
- Show title, cadence, next run, last run, enabled state, and last error.
- Add cancel/run-now actions.

Acceptance:

- Users can inspect and disable schedules the manager created.
- There is no hidden autonomous schedule that cannot be audited or canceled.

### PR 7: Local runtime helper audit

Repo: `local-runtime-helper`.

No v1 code change is expected. The scheduled task worker lives in
`parallel-agent-runtime` and posts through `ChatGateway`, which is already the
normal runtime path for cloud and local agents.

Acceptance:

- Document that no helper-side scheduler is introduced.
- If testing shows local relay sessions cannot distinguish scheduled messages,
  add only the minimum metadata pass-through change; do not add a second local
  scheduler.

### PR 8: Move scheduler config off `gateway_config`

Repo: `parallel-agent-runtime` + `parallel-agent-platform`.

- Finish the existing runtime plan to read scheduler-only manager config from
  `agent_heartbeat_config` instead of `gateway_config.runners.manager`.
- Platform writes cadence/due-task filters to `agent_heartbeat_config`.
- Keep `scheduled_task` separate; `agent_heartbeat_config` is for scheduler
  policy, not individual recurring jobs.

Acceptance:

- Manager cadence/due-task filters work without a `runners.manager` block.
- Scheduled-task recurrence still delivers direct messages independently.

## Open Questions

1. Should recurring schedules be allowed only for manager agents at first, or
   for any agent whose grants include scheduled-task tools? Recommendation:
   all default agent roles should have access.
2. What confirmation policy should apply when any agent creates a recurring
   autonomous schedule with potentially expensive actions?
3. Should raw cron expressions ship in v1, or should v1 stay with `at` and
   `every` shapes until parser libraries are chosen?

## Recommended First Cut

Build the smallest vertical slice:

1. Evolve `scheduled_task` and add `scheduled_task_run`.
2. Platform API to create/list/cancel schedules.
3. Runtime scheduler that posts due free-text instructions through
   `ChatGateway`.
4. Generic agent tools:
   `scheduled_task.create`, `scheduled_task.read`, `scheduled_task.update`,
   `scheduled_task.list`, and `scheduled_task.delete`.
5. Platform grant defaults for planning, coding, and manager agents.

Do not put recurrence into `Manager.Scheduler`. Keep the boundary clean:
scheduled tasks are clock-driven agent messages; manager scheduling remains
due-work-item polling. If a work item caused the schedule to exist, store that
work item as provenance, not as a delivery hop.
