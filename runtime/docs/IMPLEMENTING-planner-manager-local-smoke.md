# Implementing — Planner-on-local + manager-on-local smoke tests

This branch implements **PR4** from
[docs/local-model-readiness-runtime-prs.md](local-model-readiness-runtime-prs.md).

## Goal

Coding has `local_model_coding_smoke_test.exs`. Planner and manager
don't, so wire-shape regressions on those paths only surface in
production. Add an in-process end-to-end smoke per agent type.

## Depends on

- Runtime PR1 (#259) — capability rename so manager smoke can use
  `runtime_managed_tools`.

## Files to add

- `apps/orchestrator/test/symphony_elixir/integration/planner_local_smoke_test.exs`
  — stubs the local-relay registry + a model HTTP endpoint, dispatches
  a planner turn, asserts the model receives provider-format tool
  specs, asserts a `task.create` tool call round-trips, asserts the
  planner emits the expected events.
- `apps/orchestrator/test/symphony_elixir/integration/manager_local_smoke_test.exs`
  — same shape for manager: scheduler tick → local helper dispatch →
  tool call request (`snooze` or `dispatch_runner`) → tool result →
  completion. Verifies capability negotiation succeeds with
  `runtime_managed_tools: true`.

## Reference patterns

- Existing `local_model_coding_smoke_test.exs`.
- Test doubles in `scheduler_test.exs` (`TestRepo`, `TestManager`,
  `TestSessionResolver`, `TestGatewayConfig`).

## Acceptance criteria

- [ ] Both smoke tests run in <5s and don't require network or a
  real helper binary.
- [ ] Capability negotiation is exercised end-to-end.
- [ ] Tests cover the happy path and at least one failure path
  (e.g. `local_runtime_offline`).

## Validation

```bash
cd apps/orchestrator
mix compile --warnings-as-errors
mix test test/symphony_elixir/integration/
```
