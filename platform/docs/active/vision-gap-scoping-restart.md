# Vision Gap Scoping Restart

## Goal

Restart the scoping pass for the vision-gap checklist and turn every
unscoped gap area into a concrete scope doc or an explicit decision to
defer.

The source of truth for the gap inventory remains
[`docs/vision-gaps/`](../vision-gaps/). This doc is the working queue:
what still needs scope, in what order, and what each scope needs to
answer before implementation starts.

## Current inventory

The vision-gap docs currently track 18 gap areas. Three are closed,
eight have an active scope or PR plan, and seven still lack a dedicated
implementation scope.

| Gap | Current status | Restart action |
|---|---|---|
| 1.1 Workspace concurrency caps | No scope doc | Write platform + runtime scope |
| 1.2 Plan-as-fanout dashboard view | Scoped in `plan-fanout-dashboard-scope.md` | Use this as the first fanout/orchestrator-ready work-item scope |
| 2.1 Per-task model overrides | Open question + reference PR plan | Refresh into active implementation scope if still current |
| 2.2 Credential-only provider adapters | Scoped | Continue from existing scope |
| 3.1 Routing-rule editor UI | Adjacent scopes only | Write dedicated workspace routing UX scope |
| 3.2 "Where would this run?" preview | No scope doc | Write platform API + UI scope |
| 3.3 Task-label authoring UI | No scope doc | Write platform plan/task editor scope |
| 3.4 Intelligent cutovers | Scoped + PR plan | Continue from existing scope |
| 4.1 Self-review lifecycle state | Deferred; no scope doc | Decide whether to scope now or keep deferred |
| 4.2 Peer-review dispatch | Scoped for manager fallback | Continue from existing scope |
| 4.3 Auto-merge gates | Open question; no implementation scope | Resolve OQ-07, then write scope |
| 4.4 Agent persistent context | Scoped | Continue from existing scope |
| 4.5 Attention queue | Scoped | Continue from existing scope |
| 4.6 Policy schema / trust dial | Scoped | Continue from existing scope |
| 5.4 Runner SDK / third-party contract | Foundations only | Write helper-first public contract scope |

## Restart order

### Batch A: Small platform scopes that unblock UX

These are contained, mostly platform-owned, and do not need the larger
autonomous-loop policy decisions.

1. **1.1 Workspace concurrency caps**
2. **1.2 Plan-as-fanout dashboard view** - scoped in
   [`plan-fanout-dashboard-scope.md`](plan-fanout-dashboard-scope.md)
3. **3.2 "Where would this run?" preview**
4. **3.3 Task-label authoring UI**
5. **3.1 Routing-rule editor UI**

The routing UI scopes should be written in this order because the
preview and label authoring clarify the exact fields the rule editor
needs to expose.

### Batch B: Autonomous-loop decisions

These define the v1 control loop and should be scoped with policy,
review, and merge semantics in one pass.

1. **4.3 Auto-merge gates**
2. **4.1 Self-review lifecycle state**

Auto-merge should lead because it defines which gate signals are
actually consumed. Self-review can then be scoped as one gate producer,
not as an isolated lifecycle feature.

### Batch C: External extension contract

1. **5.4 Runner SDK / documented third-party contract**

This should be helper-first, with runtime/platform contract references.
Do it after the universal-tool-calling work is stable enough to avoid
publishing a contract that immediately changes.

### Batch D: Scope refreshes

1. **2.1 Per-task model overrides**

This has an open question and a reference PR plan, but no current active
implementation scope. Refresh it after the unified execution profile
work settles so the override shape plugs into the final profile model.

## Scope template

Each restarted scope should answer these sections before implementation
begins:

- **Goal:** which vision-gap checkbox this closes, and the exact user
  behavior that proves it.
- **Current state:** code paths and docs that already exist.
- **Non-goals:** what this first slice deliberately does not solve.
- **Proposed behavior:** end-to-end flow, including failure states.
- **Data model / contracts:** DB, API, shared contract, and cross-repo
  enum changes.
- **Platform work:** web/API changes.
- **Runtime work:** orchestrator, runner, relay, or scheduler changes.
- **Helper work:** only when local execution or public runner contracts
  are involved.
- **Rollout / migration:** how existing rows and active workspaces
  behave.
- **Tests:** unit, API, UI, runtime, smoke, and cross-repo drift checks.
- **Docs cleanup:** which vision-gap links/checklists update when the
  final PR ships.

## First scope stubs

### 1.1 Workspace concurrency caps

**Primary question:** cap by workspace across all agents, or by
workspace + execution target?

Likely first slice:

- Add `workspace.max_concurrent_agents` with a conservative default.
- Enforce the cap in dispatch, not only in the UI.
- Keep blocked work items queued rather than rejecting the plan.
- Surface "waiting for capacity" in plan/work-item views.
- Add runtime tests for concurrent dispatch and release-on-terminal
  states.

### 1.2 Plan-as-fanout dashboard view

Scoped in
[`plan-fanout-dashboard-scope.md`](plan-fanout-dashboard-scope.md).
The scope covers both the fanout UI and the planner tool-call contract
needed for `task.create` to produce orchestrator-ready `work_items`
rows.

### 3.2 Routing preview

**Primary question:** should preview resolve hypothetical tasks through
the same server path as saved agents, or should the client simulate?

Likely first slice:

- Add a server preview endpoint that accepts draft task labels,
  workspace id, optional agent id, and optional execution overrides.
- Reuse the production resolver and return runner, provider,
  credential reference, model, and skip/fallback notes.
- Add a compact preview to plan creation before dispatch.
- Treat preview as advisory; dispatch remains authoritative.

### 3.3 Task-label authoring UI

**Primary question:** labels live on plan-task drafts only, or also on
persisted work items after creation?

Likely first slice:

- Add label editing to plan/task creation UI.
- Persist labels in the canonical plan/work-item shape.
- Validate reserved label namespaces such as `model:` or `runner:`.
- Feed labels into the routing preview from 3.2.

### 3.1 Routing-rule editor UI

**Primary question:** rule builder only, or builder plus raw JSON escape
hatch for early power users?

Likely first slice:

- Workspace-level routing rules page.
- Rule rows with match conditions, priority, runner/provider/model
  target, and enabled state.
- Validation against shared runner/provider enums.
- Inline preview using the 3.2 endpoint.

### 4.3 Auto-merge gates

**Primary question:** which gate result is authoritative: internal
`completionGates`, GitHub checks, review_request rows, or all of them
through a normalized gate ledger?

Likely first slice:

- Resolve OQ-07 into a concrete v1 gate set.
- Add gate evaluation state that can consume tests, lint, review, and
  policy results.
- Add an explicit auto-merge decision with audit fields.
- Keep actual merge execution behind workspace policy from 4.6.

### 4.1 Self-review lifecycle

**Primary question:** does self-review run before peer review for every
coding task, or only when the task declares a self-review gate?

Likely first slice:

- Add authoring-agent self-review as a gate producer.
- Persist self-review verdict, summary, and findings.
- Allow "revise in place" to transition back to producing.
- Do not make it required for v1 auto-merge unless 4.3 selects it.

### 5.4 Runner SDK / third-party contract

**Primary question:** public Go package, protocol-only documentation, or
both?

Likely first slice:

- Document the helper runner interface and relay message contract.
- Publish a minimal example runner outside internal packages.
- Define compatibility/versioning rules for runner capabilities.
- Add contract tests that a third-party runner can run locally.

### 2.1 Per-task model overrides

**Primary question:** overrides are label-based, structured plan
metadata, or both with labels compiling into metadata?

Likely first slice:

- Refresh OQ-04 against the current execution-profile model.
- Define override precedence relative to agent defaults, routing rules,
  and workspace defaults.
- Require credential references by id, never secret values.
- Make override decisions visible in routing preview.

## Definition of done

This restart is complete when every row above either has:

- a linked active scope doc with implementation-ready decisions, or
- an explicit deferred decision recorded in the relevant vision-gap doc.

Do not tick the vision-gap checkboxes from this restart doc. Checkboxes
move only when the implementation scope has fully shipped.
