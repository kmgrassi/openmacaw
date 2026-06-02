# Plan Fanout Dashboard and Orchestrator-Ready Work Items - Scope

## Goal

Close vision gap **1.2 Plan-as-fanout dashboard view** by making plans
visible as an orchestrator fanout, and by hardening the planner tool
contract that creates the fanout.

The product model is:

1. The user asks the planning agent for a plan.
2. The planning agent uses `plan.create` and `task.create`.
3. Each `task.create` writes a canonical `work_items` row that is
   already ready for the orchestrator to poll, route, and dispatch.
4. The plan view shows those work items as parallel lanes, including
   dependency blockers, routing target, live state, and run handoff.

The dashboard is useful only if the rows are dispatchable. This scope
therefore treats the tool-call contract and the UI as one slice.

Companion runtime scope:
[`parallel-agent-runtime/docs/plan-fanout-orchestrator-ready-work-items-runtime-scope.md`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/plan-fanout-orchestrator-ready-work-items-runtime-scope.md).

## Current State

### What already exists

- Runtime planner tools include `plan.create` and `task.create` in
  `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/tool_registry.ex`.
- `task.create` writes directly to `work_items` through
  `SymphonyElixir.Planner.DatabaseTools`.
- `Payloads.task_create_payload/5` already writes the core
  orchestrator-facing fields: `workspace_id`, `plan_id`, `title`,
  `instructions`, `state`, `source = "planner"`, `runner_kind`,
  `repository`, `labels`, `depends_on`, `completion_gates`,
  `next_poll_at`, `manager_runner_id`, and `metadata.routing`.
- Runtime `Tracker.Database` reads executable work from `work_items`.
- Runtime `WorkItem.Mapper.from_database_row/1` maps `work_items` rows
  into the orchestrator's stable `WorkItem` struct.
- Platform manual plan creation already converts plan tasks into
  `work_items` rows in `apps/api/src/services/plans.ts`, including
  dependency id remapping for draft task ids.
- Platform has `/work`, `PlanDetail`, and plans/work-items queries, but
  the view is still list-first rather than fanout-first.

### Confirmed already done

The planner tool path is not starting from zero. The following behavior
already exists and should not be re-scoped as new implementation:

- `task.create` inserts into `work_items`, not legacy `task`.
- `task.create` verifies `plan_id` belongs to the same workspace before
  inserting.
- Plan `default_runner_kind` and `metadata.default_repository` are
  inherited by `task.create` when the task does not override them.
- Tool-context defaults for repository and runner kind are inherited
  when no plan is present.
- Top-level `runner_kind` and `repository` are stored both as
  `work_items` columns and mirrored into metadata.
- `routing` is stored under `metadata.routing`.
- Unsupported `runner_kind` values are rejected before a database write.
- Planner prompt guidance already tells the model to use canonical
  runtime runner kinds and to ask for clarification when repository or
  runner is unclear.
- The platform API plan-creation path already remaps draft task ids into
  canonical `work_items.depends_on` ids.

### Gaps

- Planner-created dependencies are not guaranteed to be canonical
  work-item ids. The manual API path remaps draft ids to inserted
  work-item ids, but separate planner `task.create` calls cannot rely
  on that in-memory map unless the tool layer provides one.
- `task.create` can accept both top-level `runner_kind` and structured
  `metadata.routing.runner_kind`, but there is no explicit conflict
  check called out in current tests.
- The tool result does not clearly report whether the row is
  immediately dispatch-eligible, blocked by dependencies, waiting for a
  future poll time, or only a draft/planned item.
- The plan view does not make fanout visible: lanes, dependency
  blockers, routing target, active run, and terminal state are not shown
  as the primary view.
- Platform and runtime do not share a small named test contract for
  "planner task tool output can be consumed by the orchestrator."

## Non-Goals

- Do not replace the orchestrator's polling model with a platform push
  API.
- Do not build workspace concurrency caps here. This view should display
  capacity waits once 1.1 exists, but not implement the cap.
- Do not solve routing-rule editing, preview, or label authoring beyond
  the fields needed to display the resulting route.
- Do not implement auto-merge, self-review, or attention queue gates.
  This scope only preserves `completion_gates` as dispatch context.
- Do not create a new plan table or second task queue.

## Proposed Behavior

### Planner-created fanout

The planning agent should create a plan and N work items in a shape the
orchestrator can consume without a translation step.

For executable coding work, `task.create` already produces most of the
needed `work_items` row. Keep that behavior and make the missing parts
explicit.

The row must continue to include:

- `workspace_id`
- `plan_id`
- `title`
- `instructions`
- `state = "todo"` unless deliberately scheduled for manager pickup or
  paused
- `source = "planner"`
- `runner_kind` when the planner knows the backend, otherwise enough
  `metadata.routing` for the resolver to choose one
- `repository` or `metadata.repository` when repository-scoped work is
  intended
- `labels` as a normalized string array
- `depends_on` containing canonical work-item ids, not only planner
  draft ids
- `completion_gates` preserved as a string array
- `metadata.created_via = "planner_task_tool"`
- `metadata.planner_tool = "task.create"`

This scope does **not** need to add those fields from scratch. It needs
to prove they remain present and add the missing dependency and
dispatch-summary behavior below.

Rows that are not meant for immediate orchestrator dispatch must be
explicit about why:

- future manager work: `state` plus `next_poll_at`;
- blocked work: `depends_on` points to unfinished work-item ids;
- draft/non-executable note: state or metadata marks it as not ready,
  and the fanout view renders it outside the dispatch lanes.

### Dependency handling

The runtime planner tool layer needs a stable way to convert planner
author ids into work-item ids across a multi-call plan creation flow.

Scope the implementation to one of these approaches, chosen during the
runtime pass:

- **Preferred:** add optional `author_task_id` and
  `depends_on_author_ids` fields to `task.create`. The tool executor
  keeps a session-local map from `author_task_id` to inserted work-item
  id for the current planner session and writes canonical ids into
  `work_items.depends_on`.
- **Fallback:** allow the planner to create all tasks in one
  `plan.create_with_tasks` tool call that can perform the same id
  remapping transactionally.

Do not leave dependency remapping to the model prompt alone.

### Validation feedback, smart defaults, and dispatch eligibility

The planner should not ask the user for every field. It should fill
smart defaults when the platform/runtime already has enough context,
and ask the user only when a missing value changes the actual work.

Defaulting rules:

- `name` / title: derive a short title from the user request or
  instructions when possible. Ask only if the task itself is ambiguous.
- `instructions`: default to `description`, then `name`.
- `runner_kind`: use explicit user intent first, then plan default,
  then tool/session/workspace default. Ask only when multiple runnable
  backends are plausible and the choice matters.
- `repository`: use explicit user intent first, then plan default, then
  tool/session repository context. Ask only when the request spans
  multiple repositories and no task-specific repository can be inferred.
- `labels`: infer low-risk routing/status labels from the plan/task
  shape; never infer secrets or credentials.
- `completion_gates`: inherit from plan/workspace defaults when those
  exist; do not block task creation only because gates are unspecified.

When a tool call fails validation, the failure should be returned to the
planner as actionable feedback:

```json
{
  "error": {
    "code": "invalid_tool_arguments",
    "field": "name",
    "message": "name is required",
    "recoverable": true,
    "suggested_default": "Implement plan fanout read model",
    "ask_user": false
  }
}
```

The planner should retry with `suggested_default` when `ask_user` is
false. If `ask_user` is true, it should ask one concise user question
instead of failing the plan.

For successful creates, `task.create` should return the inserted row
plus a small computed dispatch summary:

```json
{
  "work_item": { "...": "inserted row" },
  "dispatch": {
    "eligible": true,
    "reason": "ready",
    "blocked_by": [],
    "runner_kind": "codex",
    "repository": "owner/repo"
  }
}
```

Example reasons: `ready`, `blocked_by_dependencies`,
`waiting_until_next_poll_at`, `missing_route`, `draft_or_paused`, and
`invalid_for_orchestrator`.

The orchestrator remains authoritative at poll time; this summary is
tool feedback and UI metadata, not a dispatch lock.

### Fanout UI

The plan detail view should make parallelism visible:

- one lane/card per work item;
- state, title, repository, runner kind, model/provider when available;
- dependency blockers and downstream dependents;
- dispatch eligibility summary when available;
- current run/session link when a broker/runtime run exists;
- terminal state, latest updated time, and error/escalation badge when
  available;
- clear grouping for ready, blocked, running, and terminal work.

Use the existing plan/work-items routes and query keys. Do not create a
second primary dashboard.

## Data Model and Contracts

### Runtime planner tool contract

Update the runtime `task.create` schema to include the dependency
author-id contract:

- `author_task_id?: string`
- `depends_on_author_ids?: string[]`
- existing `depends_on?: string[]` remains supported for canonical
  work-item ids.

Validation rules to add or verify:

- If `depends_on_author_ids` is supplied, every referenced author id
  must have been created earlier in the same planner session or the call
  fails with an actionable tool error.
- If both `depends_on` and `depends_on_author_ids` are supplied, merge
  and dedupe after resolving author ids.
- If `runner_kind` is supplied, it must remain one of
  `ExecutionProfile.supported_runner_kinds()`. This already exists;
  keep the test.
- If `metadata.routing.runner_kind` conflicts with top-level
  `runner_kind`, fail instead of silently choosing one.
- If the task is executable and neither `runner_kind` nor a routing hint
  is present, return `dispatch.reason = "missing_route"` unless a plan
  default or workspace default is inherited.

### Platform API contract

The platform read model should expose enough data for the fanout view:

- plan defaults: `defaultRunnerKind`, `defaultModel`, default
  repository from metadata if present;
- work-item routing: `runnerKind`, `repository`, `labels`,
  `completionGates`, `dependsOn`;
- dispatch/run context when available;
- `metadata.routing` and `metadata.dispatch` as structured metadata
  when present.

### Shared contract naming

Add or document a named contract for this shape. Candidates:

- `contracts/work-items.ts`: `OrchestratorReadyWorkItemSchema`
- runtime equivalent in `WorkItem.Mapper` tests

The contract should describe the row shape the orchestrator consumes,
not a new storage table.

## PR Plan

### PR 1 - Runtime planner dependency contract

**Repo:** `parallel-agent-runtime`

**Goal:** make separate planner `task.create` calls able to express
dependencies using planner-authored task ids while still persisting
canonical `work_items.depends_on` ids.

Work:

- Add optional `author_task_id` to `task.create`.
- Add optional `depends_on_author_ids` to `task.create`.
- Store `author_task_id` in metadata unless a top-level column is added
  elsewhere.
- Add a planner-session-local map from `author_task_id` to inserted
  `work_items.id`.
- Resolve `depends_on_author_ids` into canonical ids before insert.
- Merge resolved ids with existing `depends_on` and dedupe.
- Fail with an actionable tool error if a referenced author id has not
  been created in the current planner session.
- Update planner prompt guidance to prefer `author_task_id` and
  `depends_on_author_ids` for multi-task plans.

Tests:

- `task.create(author_task_id: "A")` followed by
  `task.create(author_task_id: "B", depends_on_author_ids: ["A"])`
  inserts B with `depends_on = [A_work_item_id]`.
- Unknown `depends_on_author_ids` fails before insert.
- Existing behavior for plan default runner inheritance, repository
  inheritance, invalid runner rejection, and same-workspace `plan_id`
  validation remains covered.

### PR 2 - Runtime validation feedback, smart defaults, and dispatch readiness

**Repo:** `parallel-agent-runtime`

**Goal:** make planner tool feedback actionable, apply smart defaults
before asking the user, and report whether a created work item is ready
for orchestrator polling.

Work:

- Add a small defaulting layer for `task.create` that applies
  inferable values for title/name, instructions, runner kind,
  repository, labels, and completion gates.
- Preserve existing explicit user/model values over defaults.
- Return structured validation failures with `field`, `recoverable`,
  optional `suggested_default`, and `ask_user`.
- Update planner instructions so the model retries recoverable tool
  validation failures and asks the user only when `ask_user` is true.
- Reject conflicts between top-level `runner_kind` and
  `metadata.routing.runner_kind`.
- Compute a non-authoritative dispatch summary for `task.create`
  results:
  - `eligible`
  - `reason`
  - `blocked_by`
  - `runner_kind`
  - `repository`
- Use reason values: `ready`, `blocked_by_dependencies`,
  `waiting_until_next_poll_at`, `missing_route`, `draft_or_paused`,
  `invalid_for_orchestrator`.
- Return the inserted row plus the dispatch summary from the tool call.
- Keep the orchestrator poll-time dispatch policy authoritative.

Tests:

- Missing `name` with enough context gets a suggested default and does
  not force a user question.
- Ambiguous repository across multiple candidates returns `ask_user =
  true`.
- Explicit `runner_kind` / `repository` values are never overwritten by
  defaults.
- Conflicting top-level and routing `runner_kind` returns an error and
  does not insert.
- A routed todo item with no dependencies returns `ready`.
- A dependency-blocked item returns `blocked_by_dependencies`.
- A task with neither runner nor inherited/default route returns
  `missing_route`.
- Future `next_poll_at` returns `waiting_until_next_poll_at`.

### PR 3 - Platform fanout read model and graph helpers

**Repo:** `parallel-agent-platform`

**Goal:** prepare the web/API read model for a fanout view without
changing planner creation semantics.

Work:

- Extend `WorkItemProjection` only where needed to expose existing
  route/run fields:
  - `runnerKind`
  - `repository`
  - `labels`
  - `dependsOn`
  - `completionGates`
  - structured `metadata.routing`
  - structured `metadata.dispatch` if PR 2 persists or returns it in a
    stored field later
- Add dependency graph helpers for:
  - canonical work-item id lookup;
  - unresolved blockers;
  - downstream dependents;
  - ready/blocked/running/terminal grouping.
- Add plan-default fallback helpers so the UI can show inherited runner
  and repository when item columns are null.

Tests:

- A plan with B depending on A groups B as blocked.
- An unresolved dependency id renders as unresolved rather than
  disappearing.
- An item with null `runnerKind` displays the plan default.

### PR 4 - Platform plan fanout UI

**Repo:** `parallel-agent-platform`

**Goal:** make plan detail show the orchestrator fanout as the primary
view.

Work:

- Create the fanout view inside the existing plan detail surface.
- Render one lane/card per work item.
- Show state, title, repository, runner kind, model/provider when
  available, dependency blockers, current run/session link when
  available, terminal status, and latest update time.
- Keep the existing list/table view available for dense operations if
  useful, but make fanout the default for plan detail.
- Use existing plan/work-item query keys and invalidation paths.

Tests:

- Fanout lanes render for each work item.
- Blocked items identify blockers.
- Route chips render from item fields or plan defaults.
- Running/terminal states display distinctly.

### PR 5 - Cross-repo smoke and docs sync

**Repos:** `parallel-agent-platform`, `parallel-agent-runtime`, and
mirrored vision-gap docs where needed.

**Goal:** prove the planner-to-orchestrator fanout path end to end and
update the vision-gap references.

Work:

- Add or update a smoke that asks the planning agent to create a
  multi-task plan with one dependency.
- Verify `plan.create` and `task.create` tool calls are visible.
- Verify three `work_items` rows exist with `source = "planner"`.
- Verify dependency rows contain canonical ids.
- Verify the plan detail view shows three fanout lanes.
- Verify the orchestrator can pick up the ready lane without a manual
  translation or handoff step.
- Link this scope from `docs/vision-gaps/01-parallel-by-default.md` in
  each mirrored repo when implementation starts or lands, per the
  vision-gaps maintenance contract.

## Rollout

- Existing planner-created rows keep working.
- New `author_task_id` fields are optional.
- If a previous row has draft ids in `depends_on`, the UI should display
  them as unresolved blockers rather than hiding them.
- Once the new tool behavior ships, update the planner model prompt to
  prefer `author_task_id` and `depends_on_author_ids` when creating a
  multi-task plan.

## Open Questions

- Should `author_task_id` be stored top-level on `work_items`, or only
  in `metadata.author_task_id`?
- Is `depends_on` allowed to contain unresolved external ids for future
  cross-plan dependencies, or should it be strictly canonical
  work-item ids?
- Should dispatch eligibility be persisted in `metadata.dispatch` or
  only returned from the tool call and recomputed in the UI/API?
- Where should latest run/session status join from for the first UI
  slice: broker runs, runtime sessions, message logs, or an existing
  diagnostic endpoint?
- What exact confidence threshold makes a default safe enough to retry
  automatically instead of asking the user?

## Definition of Done

- Planner `task.create` can produce dependency-safe, route-aware
  `work_items` rows ready for orchestrator polling.
- The plan detail view renders those rows as a fanout, not just a flat
  list.
- Tests cover planner tool creation, dependency remapping, routing
  validation, and fanout UI grouping.
- `docs/vision-gaps/01-parallel-by-default.md` links this scope under
  gap 1.2 in all mirrored repos when the scope is adopted.
