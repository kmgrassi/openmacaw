# Planner Task Tool To Work Items Scope

## Goal

Move the planning-agent task tools off the legacy `public.task` table. The planner should continue exposing user-facing task tools, but those tools should create/read/update `public.work_items` rows directly.

The intended mental model after this change:

- `plan.create` writes `public.plan`.
- `task.create`, `task.update`, and `task.read` operate on `public.work_items`.
- The task tool result IDs are work item IDs, so plan review, coding handoff, and runtime routing all speak the same ID language.
- The planner no longer depends on the `task -> work_items` projection trigger for newly-created tasks.

## Previous State

Runtime planner tools live in:

- `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`

Previous behavior:

- `@task_table` was `"task"`.
- `task.create` inserts `workspace_id`, `plan_id`, `name`, `description`, `priority`, `labels`, and `metadata` into `public.task`.
- Supabase triggers project that `task` row into `public.work_items`.
- The returned ID is the `task.id`, not the projected `work_items.id`.

The runtime/orchestrator queue already reads `work_items`:

- `apps/orchestrator/lib/symphony_elixir/tracker/database.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/work_item_row.ex`
- `apps/orchestrator/lib/symphony_elixir/work_item/mapper.ex`

Platform plan review and handoff also validate selected task IDs against `work_items.id`, not `task.id`:

- `parallel-agent-platform/apps/api/src/services/planning-handoff.ts`
- `parallel-agent-platform/apps/api/src/routes/plan-reviews.ts`

That mismatch is the reason to do this migration now: planner-created task IDs are currently legacy task IDs, while the rest of the planner-to-coding path wants work item IDs.

## Required Work Item Shape

Planner-created work items should provide enough structure for review and eventual routing.

Minimum insert payload for `task.create`:

```json
{
  "workspace_id": "<workspace uuid>",
  "plan_id": "<plan uuid or null>",
  "title": "<task title>",
  "description": "<task description or null>",
  "instructions": "<task instructions or description>",
  "state": "todo",
  "priority": "<priority or null>",
  "labels": ["..."],
  "metadata": {
    "created_via": "planner_task_tool",
    "planner_tool": "task.create"
  },
  "source": "planner"
}
```

Notes:

- Keep the external tool name `task.create`; do not rename it to `work_item.create` in this slice unless the product wants a visible contract change.
- Tool input should say that `name` maps to `work_items.title`.
- Add optional `instructions`, `depends_on`, `completion_gates`, and `metadata`.
- If `instructions` is omitted, use `description`; if both are omitted, use `name`.
- `state` should default to `"todo"` to preserve current planner-created task behavior. Do not make planner output immediately dispatchable by default unless product explicitly chooses that. Manager scheduler dispatch currently requires states like `"running"` / `"awaiting_review"` plus `next_poll_at`; direct handoff flows use selected `work_items.id`.
- Preserve workspace override behavior in `Runner.Planner`: database tools must use the stored agent workspace ID, not a model-guessed workspace ID.

Fields worth exposing to the model:

- Required: `workspace_id`, `name`
- Optional: `plan_id`, `description`, `instructions`, `priority`, `labels`, `metadata`, `depends_on`, `completion_gates`, `state`

Suggested tool description update:

> Create a work item row in the platform database, optionally linked to a plan. The returned `id` is the work item ID used for plan review, coding handoff, and runtime routing. Use `name` for the user-facing task title and `instructions` for the work the coding agent should perform.

## Implementation Plan

1. Update `DatabaseTools`.
   - Done in this branch: task operations target `"work_items"` instead of `"task"`.
   - Done in this branch: `name` maps to `title`.
   - Done in this branch: `description` and `instructions` are mapped explicitly.
   - Done in this branch: `plan_id` workspace verification still checks `public.plan`.
   - Done in this branch: task tools return the inserted/updated work item row.

2. Update tool schemas.
   - Done in this branch: keep `task.create`, `task.update`, `task.read` names.
   - Done in this branch: describe that they operate on work items.
   - Done in this branch: clarify that `task_id` on `task.update` / `task.read` is the work item ID.

3. Update planner fallback messages.
   - `Created task "X".` can remain.
   - If the result includes `id`, consider returning `Created task "X" (work item ID: <id>).`

4. Update tests.
   - Done in this branch: `planner/database_tools_test.exs` asserts `POST /rest/v1/work_items`, not `/rest/v1/task`.
   - Done in this branch: `runner/planner_test.exs` asserts task tool payload writes `title`, `instructions`, `source`, and `metadata.created_via`.
   - Done in this branch: focused tracker tests still pass with direct work item writes.

5. Update docs.
   - Done in this branch: `planner-tool-contract.md`
   - `planning-agent-scope.md` if it still says planner task tools write `task`.
   - Done in this branch: `tracker/database.ex` module docs no longer describe `task` as canonical.
   - Done in this branch: `work_item.ex` module docs no longer describe state writeback through `task_id` as the primary path.

6. Decide writeback behavior.
   - Current `Tracker.Database` can write state back to `task` via `work_items.task_id`.
   - For planner-created direct work items, `task_id` will be null.
   - The desired future is to write state to `work_items.state`, not `task.status`.
   - For this slice, default work item writeback remains the `work_items` table unless a legacy `writeback` override is configured.

## Acceptance Criteria

- `task.create` no longer posts to `/rest/v1/task`.
- Planner-created tasks show up as `work_items` rows with `plan_id`, `workspace_id`, `title`, and useful `instructions`.
- The returned task IDs from planner messages are usable by platform plan review and coding handoff without translation.
- Existing planner browser flow still creates a plan and multiple linked tasks.
- Focused tests pass:

```sh
cd apps/orchestrator
mix test \
  test/symphony_elixir/planner/database_tools_test.exs \
  test/symphony_elixir/runner/planner_test.exs \
  test/symphony_elixir/dynamic_tool_test.exs \
  test/symphony_elixir/tracker/database_test.exs
```

## Follow-Ups Not In This Slice

- Fully dropping `public.task`.
- Removing task projection triggers from platform migrations.
- Renaming external model-facing tools from `task.*` to `work_item.*`.
- Making planner-created work items automatically dispatch to coding agents without an explicit review/handoff decision.
