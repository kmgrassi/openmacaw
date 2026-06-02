# Plan Fanout Runtime PR 1 - Planner Dependency Contract

Scope source:
`parallel-agent-platform/docs/active/plan-fanout-dashboard-scope.md`

## Goal

Let the planner create multi-task plans with dependencies across
separate `task.create` calls without knowing database ids ahead of time.

## Work

- Add optional `author_task_id` to the `task.create` tool schema.
- Add optional `depends_on_author_ids` to the `task.create` tool schema.
- Store `author_task_id` in `metadata.author_task_id`.
- Add a planner-session-local map from `author_task_id` to inserted
  `work_items.id`.
- Resolve `depends_on_author_ids` into canonical ids before insert.
- Merge resolved ids with any existing `depends_on` values and dedupe.
- Fail before insert when a referenced author id is unknown in the
  current planner session.
- Update planner instructions to use `author_task_id` and
  `depends_on_author_ids` for multi-task plans.

## Acceptance

- A then B with `depends_on_author_ids: ["A"]` inserts B with
  canonical `depends_on = [A_work_item_id]`.
- Unknown author dependencies fail before PostgREST insert.
- Existing canonical `depends_on` values are preserved.
- Existing `task.create` behavior for plan defaults and runner
  validation remains covered.
