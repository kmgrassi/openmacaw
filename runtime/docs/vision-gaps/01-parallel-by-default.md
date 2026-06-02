# Pillar 1 — Parallel by Default

> **Vision criterion:** A user can submit a plan with N tasks and watch
> N agents process them concurrently, with a real-time dashboard.
> ([product vision](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/reference/product-vision.md))

> **Mirrored** across
> [platform](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/vision-gaps/01-parallel-by-default.md),
> [runtime](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/vision-gaps/01-parallel-by-default.md),
> [helper](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/vision-gaps/01-parallel-by-default.md).
> Edit all three together.

## Today

`plan` table + plan-creation API ship; planner creates work items with
`dependsOn` edges; orchestrator dispatch loop runs many agents
concurrently; web has `PlansList` / `PlanDetail` views. The "submit a
plan, N agents fan out" loop works end-to-end for coding.

## Progress

Tick a box when the gap area's scope has fully shipped (all PRs merged,
scope doc moved to `docs/shipped/`). See the
[umbrella README](README.md#maintenance-contract) for the maintenance
contract.

- [ ] **1.1 Workspace concurrency caps** — scope: [workspace-concurrency-caps-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/workspace-concurrency-caps-scope.md) · runtime companion: [workspace-concurrency-caps-runtime-scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/workspace-concurrency-caps-runtime-scope.md) · schema companion: [workspace-concurrency-caps-schema-scope](https://github.com/kmgrassi/harper-server/blob/main/docs/workspace-concurrency-caps-schema-scope.md)
- [ ] **1.2 Plan-as-fanout dashboard view** — scope: [plan-fanout-dashboard-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/plan-fanout-dashboard-scope.md) · runtime companion: [plan-fanout-orchestrator-ready-work-items-runtime-scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/plan-fanout-orchestrator-ready-work-items-runtime-scope.md)

Closed: **0 / 2**.

## Gap areas

### 1.1 Workspace concurrency caps

A workspace has no DB-level or API-level limit on how many agents can be
running at once. A 200-task plan today would dispatch 200 agents
simultaneously (constrained only by infra). Need a per-workspace
`max_concurrent_agents` column, API enforcement on dispatch, and a
queue-or-reject behavior when the cap is hit.

**Active scope docs:**
- [workspace-concurrency-caps-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/workspace-concurrency-caps-scope.md)
  — cross-repo PR sequence, Platform settings API/UI, and capacity read
  model.
- [workspace-concurrency-caps-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/workspace-concurrency-caps-runtime-scope.md)
  — runtime dispatch enforcement and capacity skip behavior.
- [workspace-concurrency-caps-schema-scope (harper-server)](https://github.com/kmgrassi/harper-server/blob/main/docs/workspace-concurrency-caps-schema-scope.md)
  — `workspace_settings.max_concurrent_agents` schema.

### 1.2 Plan-as-fanout dashboard view

Today's `PlanDetail` view renders work items as a flat list. The pillar
asks for "watch N agents process them concurrently" — a view that makes
the parallelism visible: per-task lane, live status, which agent /
runner is on each one, dependency edges drawn. The data is all there;
the visualization isn't.

**Active scope docs:**
- [plan-fanout-dashboard-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/plan-fanout-dashboard-scope.md)
  — plan fanout UI plus cross-repo PR sequence.
- [plan-fanout-orchestrator-ready-work-items-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/plan-fanout-orchestrator-ready-work-items-runtime-scope.md)
  — planner `task.create` dependency contract, route conflict
  validation, and dispatch-readiness feedback.

Adjacent UI / infrastructure work:
- [per-workspace-tracker-selector-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/per-workspace-tracker-selector-scope.md)
  — per-workspace tracker UI, related but not the fanout view.
- [session-current-plan-id-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/session-current-plan-id-scope.md)
  — plan session continuity in the runtime, infrastructure-adjacent.
