# Plan Fanout Runtime PR 2 - Validation Feedback and Dispatch Readiness

Scope source:
`parallel-agent-platform/docs/active/plan-fanout-dashboard-scope.md`

## Goal

Make `task.create` feedback actionable, apply smart defaults before
asking the user, and report whether a created work item is ready for
orchestrator polling while keeping poll-time dispatch policy
authoritative.

## Work

- Add smart defaults for inferable `name`, `instructions`,
  `runner_kind`, `repository`, `labels`, and `completion_gates`.
- Never overwrite explicit model/user values with defaults.
- Return structured validation failures with `field`, `recoverable`,
  optional `suggested_default`, and `ask_user`.
- Update planner instructions to retry recoverable validation failures
  when `ask_user` is false, and ask one concise user question when
  `ask_user` is true.
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
- Return the inserted row plus dispatch summary from the tool call.

## Acceptance

- Missing `name` with enough context gets a suggested default and does
  not force a user question.
- Ambiguous repository across multiple candidates returns `ask_user =
  true`.
- Explicit `runner_kind` and `repository` values are not overwritten by
  defaults.
- Conflicting route fields return an error and do not insert.
- Routed todo items with no dependencies return `ready`.
- Dependency-blocked items return `blocked_by_dependencies`.
- Missing route returns `missing_route`.
- Future `next_poll_at` returns `waiting_until_next_poll_at`.
