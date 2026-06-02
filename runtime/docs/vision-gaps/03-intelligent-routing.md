# Pillar 3 — Intelligent Routing

> **Vision criterion:** A user can write a per-workspace routing rule
> like `runner:local for label=triage` and the orchestrator obeys it.
> ([product vision](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/reference/product-vision.md))

> **Mirrored** across
> [platform](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/vision-gaps/03-intelligent-routing.md),
> [runtime](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/vision-gaps/03-intelligent-routing.md),
> [helper](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/vision-gaps/03-intelligent-routing.md).
> Edit all three together.

## Today

`routing_rule` table + resolution logic in
`apps/api/src/repositories/routing-rules.ts`; runtime's
`ExecutionProfile` module maps a routing rule to a runner behavior; a
diagnostic endpoint at
`/api/diagnostic/agents/:agentId?workspaceId=...` previews resolution
for an agent. DB check constraints prevent invalid `runner_kind` /
`provider` values. Label-based routing at the runner layer
(`SymphonyElixir.Runner.resolve`) exists.

The pieces are in place. The gaps are mostly **UX** (editor, preview,
labels) and **dynamic behavior** (cutovers).

## Progress

Tick a box when the gap area's scope has fully shipped (all PRs merged,
scope doc moved to `docs/shipped/`). See the
[umbrella README](README.md#maintenance-contract) for the maintenance
contract.

- [ ] **3.1 Routing-rule editor UI** — adjacent: [canonical-work-items-routing-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/canonical-work-items-routing-scope.md), [execution-target-schema-pr-plan](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/execution-target-schema-pr-plan.md), [oq-03](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/open-questions/oq-03-routing-config-schema.md)
- [ ] **3.2 "Where would this run?" preview** — _no scope doc yet_
- [ ] **3.3 Task-label authoring UI** — _no scope doc yet_
- [ ] **3.4 Intelligent cutovers** — scope: [intelligent-cutovers-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/intelligent-cutovers-scope.md) · PR plan: [intelligent-cutovers-pr-plan](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/intelligent-cutovers-pr-plan.md) · runtime companion: [intelligent-cutovers-runtime-scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/intelligent-cutovers-runtime-scope.md)

Closed: **0 / 4**.

## Gap areas

### 3.1 Routing-rule editor UI

Routing rules today are edited at the per-agent settings level or
directly in DB. There's no workspace-level rule builder where a user can
write "all `qa-*` tasks → ComputerUse; all `code-*` → Codex." Need a
rule editor that compiles to the `routing_rule` schema, with validation
against the runner kind allowlist.

**Active scope docs:**
- [canonical-work-items-routing-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/canonical-work-items-routing-scope.md)
  — routing-rule schema and resolution path.
- [canonical-work-items-routing-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/canonical-work-items-routing-scope.md)
  — runtime side of the same.
- [execution-target-schema-pr-plan (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/execution-target-schema-pr-plan.md)
  — execution-target shape underlying rule resolution.
- [oq-03-routing-config-schema (open question)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/open-questions/oq-03-routing-config-schema.md)
  — design call on the routing config JSON shape.

### 3.2 "Where would this run?" preview at plan-submit time

The diagnostic endpoint can show routing resolution for an existing
agent, but there's no plan-submit-time preview that shows, for each task
in the proposed plan, which runner/model would handle it. Vision pillar
asks for this so users can sanity-check routing before they fire off N
agents.

**Active scope docs:** _No scope doc yet._ Foundation exists: the
diagnostic endpoint
(`apps/api/src/routes/diagnostic-agents.ts`) is the right starting
shape — the gap is making it work for a hypothetical task spec rather
than a saved agent, and surfacing in the plan-creation UI.

### 3.3 Task-label authoring UI

Labels are a first-class part of the routing priority list (the vision
ranks them #1, above plan rules and workspace defaults). They exist in
the runtime's resolver but there's no UI on a task or plan editor to
set them.

**Active scope docs:** _No scope doc yet._

### 3.4 Intelligent cutovers

**Two related problems that today have no coherent design:**

1. **Rate-limit / refusal fallback.** When a chosen provider rate-limits
   the agent (or refuses for content-policy reasons, or its endpoint is
   down), the agent should fall back to a designated alternative model
   for the rest of the turn — not fail the task. Need a fallback chain
   per execution profile, the trigger conditions (HTTP 429, 5xx, provider
   refusal codes, timeout thresholds), and the carry-over semantics for
   message history across the cutover (the
   [model-agnostic message store](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/shipped/model-agnostic-message-store-plan.md)
   foundation makes this possible).

2. **Per-agent model-tier constraints (adequacy floor).** Some agents
   should only ever use top-tier models — e.g. a coding agent where a
   small model would produce unusable diffs. The agent (or its execution
   profile) needs to declare "frontier-only" or "any model OK," and the
   cutover logic must respect that floor — if the only available
   fallback is below the floor, the task should escalate to a human (see
   [4.5 Attention queue](04-autonomous-loop.md#45-attention-queue--requires_human_input-surface))
   rather than silently degrade.

These two intersect: a cutover chain has to be aware of both the
trigger (rate-limit / refusal) and the floor (this agent can't use a
small model). The current implementation has neither layer.

**Active scope docs:**
- [intelligent-cutovers-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/intelligent-cutovers-scope.md)
  — primary scope: model-tier registry, execution-profile extension,
  routing-rule columns, `provider_cutover` audit table, behavior
  contract.
- [intelligent-cutovers-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/intelligent-cutovers-runtime-scope.md)
  — companion: `Cutover` module, runner integration, cooldown tracker,
  audit-row writes.

Adjacent foundations referenced by the scopes:
- [unified-execution-profile-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/unified-execution-profile-scope.md)
  — the execution profile is the home for the fallback chain and floor.
- [credentials-streamlining-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/credentials-streamlining-scope.md)
  — fallback chains reference credentials, not API keys.
