# Pillar 4 — Autonomous Loop with Human-by-Exception

> **Vision criterion:** A plan with N coding tasks runs end-to-end
> (write → review → merge) without human intervention except where
> workspace policy explicitly requires it. The user gets ≤ one
> notification per plan on average.
> ([product vision](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/reference/product-vision.md))

> **Mirrored** across
> [platform](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/vision-gaps/04-autonomous-loop.md),
> [runtime](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/vision-gaps/04-autonomous-loop.md),
> [helper](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/vision-gaps/04-autonomous-loop.md).
> Edit all three together.

## Today

This is the **biggest gap in the product**. Agents produce work, but the
loop does not close itself:

- `work_items.state` is a free-form string set by agents, not a
  lifecycle the orchestrator enforces.
- `completionGates?: Array<"lint" | "tests" | "peer-review" | "self-review">`
  exists on the plan task contract but the orchestrator does not enforce
  it.
- No inbound webhook surface for PR / CI / review events.
- No `attention` / `requires_human_input` table or dashboard view.
- No policy schema in `gateway_config` for "trust dial" decisions.

This pillar is the spine of "the user never comes back unless the agent
says they need to." Closing it is the single largest delta to v1.

## Progress

Tick a box when the gap area's scope has fully shipped (all PRs merged,
scope doc moved to `docs/shipped/`). See the
[umbrella README](README.md#maintenance-contract) for the maintenance
contract.

- [ ] **4.1 Self-review lifecycle state** — _deferred; no scope doc yet_
- [ ] **4.2 Peer-review dispatch** — scope: [manager-pr-review-fallback-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/manager-pr-review-fallback-scope.md) · adjacent: [manager-as-regular-agent-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/manager-as-regular-agent-scope.md), [runtime companion](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/manager-as-regular-agent-runtime-scope.md)
- [ ] **4.3 Auto-merge gates** — open question [oq-07](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/open-questions/oq-07-auto-merge-gate-selection.md), no implementation scope yet
- [ ] **4.4 Agent persistent context (user- and self-editable)** — scope: [agent-persistent-context-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/agent-persistent-context-scope.md)
- [ ] **4.5 Attention queue / `requires_human_input` surface** — scope: [attention-queue-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/attention-queue-scope.md) · runtime companion: [attention-queue-runtime-scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/attention-queue-runtime-scope.md)
- [ ] **4.6 Policy schema / trust dial** — scope: [policy-trust-dial-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/policy-trust-dial-scope.md) · runtime companion: [policy-trust-dial-runtime-scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/policy-trust-dial-runtime-scope.md)

Closed: **0 / 6**.

## Gap areas

### 4.1 Self-review lifecycle state

Before requesting merge (or peer review), the agent should re-read its
own diff against a workspace-defined review checklist (style, tests,
docstrings, scope creep, etc.) and either approve, revise in place, or
flag specific concerns. Need a real `reviewing` state on the task
lifecycle (transitioning from `producing` → `reviewing` → `ready` or
back to `producing`), the review prompt template, and the
self-review-feedback persistence shape.

**Active scope docs:** _No scope doc yet._

**V1 note:** after scoping discussion, the first review slice is
manager-orchestrated peer review fallback (4.2), not author self-review.
Self-review remains a later lifecycle gap unless we decide the authoring
agent must inspect its own diff before manager / peer review.

### 4.2 Peer-review dispatch

When workspace policy says "another set of eyes," the orchestrator
should spawn a separate reviewer agent (potentially different prompt,
potentially different model — see
[3.4 Intelligent cutovers](03-intelligent-routing.md#34-intelligent-cutovers))
against the same diff. The reviewer's verdict feeds back into the
original task's lifecycle. The
[manager-as-regular-agent](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/manager-as-regular-agent-scope.md)
pattern (an agent that dispatches to sub-agents) is the structural
foundation; peer review is a specific application of it.

**Active scope docs:**
- [manager-pr-review-fallback-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/manager-pr-review-fallback-scope.md)
  — primary v1 scope: manager tool checks whether GitHub auto-review is
  already present/in-flight, then dispatches a cross-model reviewer only
  when review is missing.
- [manager-as-regular-agent-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/manager-as-regular-agent-scope.md)
  — generalized sub-agent dispatch (foundation, not peer-review specifically).
- [manager-as-regular-agent-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/manager-as-regular-agent-runtime-scope.md)
  — runtime side of the same.

### 4.3 Auto-merge gates

When the configured gates (lint, tests, peer-review, self-review,
custom) pass and policy permits, the agent should call the merge API
without asking. Today `completionGates` is a field on the plan task
schema but the orchestrator doesn't enforce it, doesn't know about
auto-merge, and has no merge-API integration. Need gate-evaluation
logic, the auto-merge action in the agent's tool surface, and the
decision rule that combines gate results + policy + escalation.

**Active scope docs:**
- [oq-07-auto-merge-gate-selection (open question)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/open-questions/oq-07-auto-merge-gate-selection.md)
  — design call on which gates are required.
- _No implementation scope doc yet._

### 4.4 Agent persistent context (user- and self-editable)

An agent should have a **persistent text context** flowing into every
turn's system prompt — workspace-tunable instructions, preferences,
and learned patterns. Today the `agent.context` column exists on the
DB but is dead data: the runtime loads it, then never reads it into
the system prompt. Users have no UI to edit it; agents have no tool
to update it.

Wiring this end-to-end (prompt injection + UI + agent-callable
update tool with optional approval gate + versioning history) is the
load-bearing mechanism for letting users (and agents themselves)
shape behavior over time — including for the upcoming manager-agent
sweep work that needs a customization surface for situation-specific
guidance.

**Active scope docs:**
- [agent-persistent-context-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/agent-persistent-context-scope.md)
  — wire up the existing `agent.context` field: prompt injection,
  user-edit UI, `agent_context.update` tool, versioning, workspace
  policy for self-update approval.

> **Note on the original 4.4.** This slot was originally scoped as
> "Webhook-in surface (PR / CI / review events)." That work was
> consciously dropped after a design discussion: chatty webhook
> streams don't pay their build cost, and the upcoming
> **manager-agent sweep** (deferred follow-up gap, expected to land
> alongside 4.4 in scoping order) is the right primary mechanism for
> closing the autonomous-loop feedback channel. The manager-agent's
> customization — what to do in specific situations — depends on
> this agent-persistent-context scope being real, which is why this
> work takes the 4.4 slot.

### 4.5 Attention queue / `requires_human_input` surface

When the agent decides "a human needs to see this" (gate failure it
can't recover, policy violation, low-confidence open question), the
plan node should pause in a clear state and the dashboard should
surface a "things waiting on me" queue. Today there's no `attention`
table, no `requires_human_input` task state, no notification surface,
and no documented re-entry semantics for when the human responds.

Re-entry is its own design problem — how does the agent pick up
exactly where it was when the human resolves the escalation? Tied to
`task.state` transitions but needs a designed lifecycle.

**Active scope docs:**
- [attention-queue-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/attention-queue-scope.md)
  — primary scope: per-kind resolution payloads, attention dashboard
  at `/workspace/:id/attention`, claim / resolve API, all-must-resolve
  invariant, `:cancelled` work item state.
- [attention-queue-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/attention-queue-runtime-scope.md)
  — companion: stateless re-entry, resumption-message construction,
  `consumed_at` write, override-just-this-once tracking.
- [oq-08-re-entry-semantics (open question)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/open-questions/oq-08-re-entry-semantics.md)
  — original design call; the scope docs above implement it.

### 4.6 Policy schema / trust dial

The "trust dial" that governs the autonomous loop — auto-merge
thresholds, paths-that-require-human, max retries per gate, cost caps,
peer-review triggers, escalation reasons — needs a schema in
`gateway_config` (versioned, scoped per workspace) and an editor UI.
The
[agent-tool-grant-data-model](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/agent-tool-grant-data-model-scope.md)
work is a partial precedent: tool grants are a form of policy (what an
agent is allowed to do). The trust dial is the broader version: under
what conditions does the agent take an irreversible action.

**Active scope docs:**
- [policy-trust-dial-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/policy-trust-dial-scope.md)
  — primary scope: `EscalationPolicy` schema, `escalation` table,
  `escalate_to_human` tool, per-task overrides, policy editor UI,
  validation at write.
- [policy-trust-dial-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/policy-trust-dial-runtime-scope.md)
  — companion: `PolicyCache`, four enforcers (structural, resource,
  gate-failure, self-flagged), real `Attention.escalate/3`.
- [oq-06-escalation-policy-schema (open question)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/open-questions/oq-06-escalation-policy-schema.md)
  — original design call; the scope docs above implement it verbatim.

Adjacent foundations:
- [agent-tool-grant-data-model-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/agent-tool-grant-data-model-scope.md)
  — tool-grant relational precedent (the "what an agent may do at
  all" layer below the trust dial).
- [agent-tool-grant-data-model-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/agent-tool-grant-data-model-runtime-scope.md)
- [agent-tool-grant-data-model-helper-scope (helper)](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/agent-tool-grant-data-model-helper-scope.md)

## How these gap areas relate

4.1 → 4.3 → 4.5 is the production sequence. The agent self-reviews
(4.1), passes/fails gates triggering auto-merge or escalation (4.3),
and on escalation surfaces to the attention queue (4.5). 4.2
(peer-review) is an optional middle step gated by 4.6 (policy).

4.4 (agent persistent context) is **orthogonal** to the production
sequence — it's the customization surface that lets users and agents
shape behavior over time. The upcoming manager-agent sweep (deferred
follow-up) is the input-pipe mechanism that closes the autonomous
loop's feedback channel; it relies on 4.4 for situation-specific
guidance.

A reasonable order to attack: **4.6 policy schema** first (it gates
4.1, 4.2, 4.3, 4.5 — all of them read from it), then **4.4 agent
persistent context** (small, foundational, unblocks the manager-agent
sweep work), then **4.1 self-review** + **4.3 auto-merge** + **4.5
attention** in parallel, with **4.2 peer-review** layered on top
once 4.1's review framework exists.
