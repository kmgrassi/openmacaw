# Onboarding Flow — Runtime Scope

Status: draft / boilerplate. Companion to the platform scoping doc at
[`parallel-agent-platform/docs/active/onboarding-flow-scope.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/onboarding-flow-scope.md)
(merged in [parallel-agent-platform#397](https://github.com/kmgrassi/parallel-agent-platform/pull/397)).
This doc covers only the work that belongs in `parallel-agent-runtime`.

## Why this exists

The platform's first-run onboarding will:

1. Sign the user up.
2. Configure all three default agents — planning, coding, manager —
   from a single OpenAI key submission on Card 4a.
3. Land the user in a conversation with the **planning agent**, which
   is the user's default conversation surface.
4. Expect the planning agent to decompose user intent into coding tasks
   and dispatch them to the **coding agent** without further user
   interaction. The user only talks to planning; coding runs in the
   background.

The runtime already has the handoff plumbing
([`apps/orchestrator/lib/symphony_elixir/planning/plan_handoff.ex`](../lib/symphony_elixir/planning/plan_handoff.ex)
validates the planner → coding launch contract). What this scope adds
is **verification that the loop works end-to-end with the default-agent
topology that onboarding creates**, plus the runtime-side pieces of
PR6 (smart per-agent defaults) from the platform scope.

If the planning → coding loop is brittle or partially wired today, the
platform will ship onboarding that lands the user in a planning
conversation, the user will type intent, and nothing will happen. That
is a worse first-run experience than today's wizard. This scope
prevents that.

## Out of scope

- Building the user-facing onboarding UI. That's the platform repo.
- Credential storage, default-agent provisioning, `resolvedAgentId`
  routing. Those are platform service concerns.
- The local-helper pairing UX. That's
  [`local-runtime-helper/docs/onboarding-flow-helper-scope.md`](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/onboarding-flow-helper-scope.md).
- New planning or coding capabilities beyond what the existing planner
  and coding runners already do. We're verifying, not building new
  reasoning.

## What we need from the runtime

### 1. End-to-end smoke for the default-agent topology

Today's planner + coding smoke tests exercise either path in isolation
(see `apps/orchestrator/test/symphony_elixir/integration/` and
[`IMPLEMENTING-planner-manager-local-smoke.md`](IMPLEMENTING-planner-manager-local-smoke.md)).
None of them cover the **full onboarding-shaped loop**:

> Fresh workspace with three default agents (planning, coding, manager),
> each configured from one provider/model. User sends a message to the
> planning agent. Planning calls `plan.create` + `task.create`. The
> coding agent launches with the reviewed plan/task IDs (via
> `plan_handoff.ex`'s `validate_launch/2`). Coding completes. The
> planner is notified and the result reaches the user transcript.

Add this as a new integration test:

- `apps/orchestrator/test/symphony_elixir/integration/onboarding_topology_smoke_test.exs`
- Stubs HTTP model endpoints for each of the three default agents.
- Constructs an Agent fixture set that mirrors what the platform's
  default-agents service creates (planning, coding, manager — same
  `type` strings, same `model_settings` / `gateway_config` shape).
- Asserts on the wire: planning dispatches with the expected handoff
  envelope, coding receives an `approved_plan_id` and
  `selected_task_ids`, coding's completion event makes it back to the
  planner's event stream.
- Runs in <10s and does not require a real helper binary, real model,
  or network.

This test is the gate. **If it doesn't pass cleanly on `main`, do not
ship the platform's PR3 (Card 4b + Card 5) until the failure is fixed
or scoped as a follow-up.**

### 2. Manager-agent launch verification

Card 4a configures all three default agents from one key. If the
manager agent's runtime path doesn't launch cleanly, onboarding
configures something that quietly doesn't run.

The capability rename in
[`local-model-readiness-runtime-prs.md`](local-model-readiness-runtime-prs.md)
PR1 (`manager_tool_calling` → `runtime_managed_tools`) needs to be
verified-in-place against the helper's current capability map. Add a
manager launch check to the topology smoke above, or a separate one:

- Manager-agent launch from the same credential set as planning + coding
  succeeds (capability negotiation passes, scheduler tick produces a
  dispatch, the dispatch round-trips).
- If the manager-agent runtime path isn't ready, the test should be
  marked `@tag :pending` with a comment pointing at the missing piece
  — never silently skipped.

### 3. Model-string verification for PR6 (smart per-agent defaults)

The platform's PR6 will pick per-agent-type default models server-side
(planning gets a reasoning-tier model, coding gets a code-gen model,
manager gets an orchestration-tier model). The strings PR6 chooses
must be routable by the runtime's `Runner.resolve`.

Add a runtime contract test (or an asset the runtime exposes) covering:

- Given a list of `(provider, model)` pairs the platform might pick as
  smart defaults (provided by the platform repo when PR6 lands),
  assert each one resolves to a runner without
  `{:error, :no_runner_for_model}` or equivalent.
- If a model string is one the runtime can't route today, fail the test
  with a clear pointer to which `Runner` would need updating.

The PR6 platform change should be paired with a runtime PR that updates
this asset and verifies routing. Do not let the platform pick model
strings the runtime hasn't been taught about.

### 4. Optional: planner → coding event observability

For the platform's Card 5 ("Launch Your First Agent") to give the user
a clean message when the loop is mid-flight, the runtime needs to emit
events the platform can show in the planning conversation. The contract
already exists (`planner.plan.created`, `planner.task.created` from
`PlanHandoff.review_event/3`); what's missing is a corresponding
`coding.task.started` / `coding.task.completed` event the planner
ingests and the platform can render.

If this isn't already wired, scope it here as PR4 — but only after PR1
proves the loop runs at all. Don't optimize visibility on a flow we
haven't yet verified.

## Proposed PR sequence

Keep each PR independently reviewable and shippable.

### PR1 — Onboarding-topology smoke test

- New integration test exercising planning → coding handoff end-to-end
  with the default-agent topology (planning, coding, manager configured
  from one provider/model set).
- Stubbed model endpoints, no helper binary, no network.
- Runs in CI alongside existing smoke tests.

Acceptance:

- [ ] Test passes on `main` with the current handoff plumbing, OR
- [ ] Test fails with a clear, named gap that becomes PR2's scope.

### PR2 — Fixes uncovered by PR1 (only if needed)

- Whichever piece of the planning → coding hand-off didn't survive PR1.
- One PR per gap, not one bundled fix.
- Each gap should reference the specific assertion in PR1 it makes pass.

### PR3 — Manager-agent launch coverage

- Extend the topology smoke (or add a sibling) covering manager-agent
  launch from the onboarding credential set.
- Verify capability negotiation, scheduler dispatch, and result frame.
- If the manager-agent runtime path is incomplete, this PR scopes the
  missing piece rather than working around it.

### PR4 — PR6 model-routing pairing (lands alongside platform PR6)

- Accept the list of per-agent-type default `(provider, model)` pairs
  from the platform repo.
- Add a routing contract test that asserts each pair resolves.
- If a pair doesn't resolve, this PR adds the runner registration /
  routing rule that makes it resolve.

## Validation

Per [`CLAUDE.md`](../../../CLAUDE.md):

```bash
cd apps/orchestrator
mix compile --warnings-as-errors
mix test
```

For PR1 specifically, also run the full local stack at least once and
manually trigger the planning → coding loop through the platform UI
(against a worktree of the platform repo that has the merged
onboarding-flow scope). The unit smoke can pass while a real-world
mismatch hides — manual verification is the second gate.

## Dependencies

- The platform's [onboarding-flow scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/onboarding-flow-scope.md)
  is merged and informs the agent topology this runtime work has to
  support.
- The helper's [onboarding-flow scope](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/onboarding-flow-helper-scope.md)
  is in parallel; the local-model arm of onboarding (Card 4b in the
  platform doc) needs both repos. PR1 in this scope only exercises the
  cloud-model arm, so it's not blocked by the helper work.

## Open questions

- Should the PR1 smoke test fixture use `MockRunner` or stub HTTP
  endpoints? Existing planner/manager smokes mix both — pick whichever
  matches the test that's closest to "user types intent, planning
  dispatches coding."
- Does the manager agent actually need a runner at all on first-run,
  or is its useful work scheduled-only? If the latter, PR3 should
  assert "manager is configured but the scheduler tick is a no-op
  until a future event" rather than asserting an immediate dispatch.
- For PR4, who owns the canonical model-default list — platform or
  runtime? Suggestion: platform owns the list (since model strings
  are credential/provider-shaped), runtime owns the test asset that
  asserts each string is routable.
