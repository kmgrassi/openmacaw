# Plan Fanout Orchestrator-Ready Work Items - Runtime Scope

Companion platform scope:
`parallel-agent-platform/docs/active/plan-fanout-dashboard-scope.md`.

## Goal

Make runtime planner `task.create` calls produce work-item dependency
data that the orchestrator can consume directly.

Most of the planner tool path already exists: `task.create` writes to
`work_items`, stores runner/repository fields, inherits plan defaults,
validates supported runner kinds, and verifies the plan belongs to the
workspace. This scope covers the missing runtime pieces only:

- resolving planner-authored task ids into canonical `work_items.id`
  dependencies across separate `task.create` calls;
- rejecting route conflicts;
- returning actionable validation and dispatch-readiness feedback to
  the planner;
- applying smart defaults so the planner asks the user only when
  ambiguity is real.

## Current State

Already implemented:

- `SymphonyElixir.Planner.DatabaseTools.execute("task.create", ...)`
  inserts directly into `work_items`.
- `Payloads.task_create_payload/5` writes `workspace_id`, `plan_id`,
  `title`, `instructions`, `state`, `source`, `runner_kind`,
  `repository`, `labels`, `depends_on`, `completion_gates`,
  `next_poll_at`, `manager_runner_id`, and `metadata.routing`.
- `task.create` inherits `default_runner_kind` and
  `metadata.default_repository` from the plan.
- `task.create` inherits tool-context repository and runner defaults
  when no plan is present.
- Top-level `runner_kind` and `repository` are mirrored into metadata.
- Unsupported runner kinds are rejected before insert.
- `Tracker.Database` reads executable work from `work_items`.
- `WorkItem.Mapper.from_database_row/1` maps rows into the
  orchestrator's stable work-item struct.

Missing:

- no `author_task_id` / `depends_on_author_ids` schema fields;
- no planner-session-local author id to work-item id map;
- no canonical dependency remapping across separate planner tool calls;
- no explicit top-level `runner_kind` vs `metadata.routing.runner_kind`
  conflict validation;
- no dispatch-readiness summary in the `task.create` tool result;
- no structured validation feedback contract with suggested defaults
  and ask-user guidance.

## PR 1 - Planner dependency contract

### Goal

Let the planner create multi-task plans with dependencies across
separate `task.create` calls without relying on the model to know
database ids ahead of time.

### Work

- Add optional `author_task_id` to the `task.create` tool schema.
- Add optional `depends_on_author_ids` to the `task.create` tool schema.
- Store `author_task_id` in `metadata.author_task_id` unless a
  top-level column is introduced elsewhere.
- Add a session-local map from `author_task_id` to inserted
  `work_items.id`.
- Resolve `depends_on_author_ids` into canonical ids before inserting.
- Merge resolved ids with any existing `depends_on` values and dedupe.
- Fail before insert when a referenced author id is unknown in the
  current planner session.
- Update planner instructions to use `author_task_id` and
  `depends_on_author_ids` for multi-task plans.

### Likely files

- `apps/orchestrator/lib/symphony_elixir/planner/database_tool_specs.ex`
- `apps/orchestrator/lib/symphony_elixir/planner/database_tools/payloads.ex`
- `apps/orchestrator/lib/symphony_elixir/planner/planner_tool_executor.ex`
- `apps/orchestrator/lib/symphony_elixir/planner/tools/context.ex`
- `apps/orchestrator/lib/symphony_elixir/planner/model_client/openai_responses.ex`
- `apps/orchestrator/test/symphony_elixir/planner/database_tools_task_create_test.exs`
- `apps/orchestrator/test/symphony_elixir/planner/planner_tool_executor_test.exs`

### Tests

- Create task A with `author_task_id: "A"`, then task B with
  `depends_on_author_ids: ["A"]`; B is inserted with
  `depends_on = [A_work_item_id]`.
- Unknown `depends_on_author_ids` returns a tool error and does not
  call PostgREST insert.
- Existing canonical `depends_on` values are preserved and deduped with
  resolved author ids.
- Existing tests for runner inheritance, repository inheritance, invalid
  runner rejection, and same-workspace plan validation still pass.

## PR 2 - Validation feedback, smart defaults, and dispatch readiness

### Goal

Make planner tool feedback actionable, apply smart defaults before
asking the user, and report whether a created row is ready for
orchestrator polling while keeping the orchestrator's actual dispatch
policy authoritative.

### Work

- Add a defaulting layer for `task.create`:
  - `name` / title: derive a short title from request or instructions
    when possible;
  - `instructions`: default to description, then name;
  - `runner_kind`: use explicit user intent, then plan default, then
    tool/session/workspace default;
  - `repository`: use explicit user intent, then plan default, then
    tool/session repository context;
  - `labels`: infer low-risk labels from task shape only;
  - `completion_gates`: inherit plan/workspace defaults when present.
- Never overwrite explicit model/user values with defaults.
- Return structured validation feedback with:
  - `code`
  - `field`
  - `message`
  - `recoverable`
  - `suggested_default`
  - `ask_user`
- Update planner instructions to retry recoverable validation failures
  when `ask_user` is false, and ask one concise user question when
  `ask_user` is true.
- Reject conflicts between top-level `runner_kind` and
  `metadata.routing.runner_kind`.
- Compute a dispatch summary for `task.create` results:
  - `eligible`
  - `reason`
  - `blocked_by`
  - `runner_kind`
  - `repository`
- Use reason values:
  - `ready`
  - `blocked_by_dependencies`
  - `waiting_until_next_poll_at`
  - `missing_route`
  - `draft_or_paused`
  - `invalid_for_orchestrator`
- Return the inserted row plus the summary in the tool output.
- Do not make this summary a dispatch lock. The orchestrator still
  re-checks state, dependencies, assignment, repository routing, and
  terminal states at poll time.

### Likely files

- `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`
- `apps/orchestrator/lib/symphony_elixir/planner/database_tools/payloads.ex`
- `apps/orchestrator/lib/symphony_elixir/orchestrator/dispatch_policy.ex`
- `apps/orchestrator/lib/symphony_elixir/work_item/mapper.ex`
- `apps/orchestrator/test/symphony_elixir/planner/database_tools_task_create_test.exs`
- `apps/orchestrator/test/symphony_elixir/workspace_and_config_test.exs`

### Tests

- Missing `name` with enough context returns a suggested default and
  does not force a user question.
- Ambiguous repository across multiple candidates returns `ask_user =
  true`.
- Explicit `runner_kind` and `repository` values are not overwritten by
  defaults.
- Conflicting top-level `runner_kind` and
  `metadata.routing.runner_kind` returns an error and does not insert.
- A routed `todo` item with no dependencies returns `ready`.
- A dependency-blocked item returns `blocked_by_dependencies`.
- A task with no runner, no routing hint, and no inherited/default route
  returns `missing_route`.
- A future `next_poll_at` returns `waiting_until_next_poll_at`.

## Non-Goals

- No platform fanout UI in this repo.
- No workspace concurrency caps.
- No new queue table.
- No platform push-to-runtime dispatch API.
- No auto-merge, self-review, peer-review, or attention queue work.

## Definition of Done

- Planner-created dependency chains use canonical `work_items` ids.
- `task.create` rejects route conflicts before insert.
- `task.create` returns dispatch-readiness feedback.
- Runtime tests cover the missing behavior and preserve existing
  planner tool behavior.
- Recoverable tool validation failures tell the planner whether to retry
  with a smart default or ask the user.
