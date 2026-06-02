# Vision Gaps — From Today to the Product Vision

The set of capabilities still missing between **today's implementation**
and the [product vision](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/reference/product-vision.md).
One doc per pillar. Each pillar doc indexes the active scoping docs
that implement that pillar's gaps, and flags gaps that don't have a
scope doc yet.

This is **high-level scoping** — system-behavior capabilities, not
PR-level deliverables. The PR-level work lives in each repo's
`docs/active/` (platform) or `docs/` (runtime, helper).

> **Mirrored.** This doc lives in three repos:
> - [parallel-agent-platform](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/vision-gaps/README.md)
> - [parallel-agent-runtime](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/vision-gaps/README.md)
> - [local-runtime-helper](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/vision-gaps/README.md)
>
> Edit all three together — if you change one, change the others in
> the same PR.

## How to use this

- **Adding a feature?** Find which pillar (and gap area) it serves. If
  it doesn't advance one, push back.
- **Scoping a feature?** If a gap area below says "no scope doc yet,"
  that's where to start. Write the scope doc in the appropriate repo's
  `docs/active/`, then update the link here.
- **Reviewing a PR?** Each gap area links to its scoping docs. If a PR
  doesn't trace back to one, ask which gap it's closing.

## Pillars

| # | Pillar | Today | Closed | Doc |
|---|---|---|---|---|
| 1 | Parallel by default | Mostly shipped | 0 / 2 | [01-parallel-by-default.md](01-parallel-by-default.md) |
| 2 | LLM-agnostic | Mostly shipped | 0 / 2 | [02-llm-agnostic.md](02-llm-agnostic.md) |
| 3 | Intelligent routing | Foundations shipped, UI thin | 0 / 4 | [03-intelligent-routing.md](03-intelligent-routing.md) |
| 4 | Autonomous loop | **Biggest gap** | 0 / 6 | [04-autonomous-loop.md](04-autonomous-loop.md) |
| 5 | Local-runtime-friendly | In flight | 3 / 4 | [05-local-runtime-friendly.md](05-local-runtime-friendly.md) |

## Progress checklist

Every gap area across all five pillars. A box is ticked when the
scope's work has **fully shipped** (all PRs merged, and any
repo-specific scope-doc follow-up is complete). Partial progress does
not tick the box — see [Maintenance contract](#maintenance-contract)
below.

**Pillar 1 — Parallel by default** (0 / 2)
- [ ] 1.1 Workspace concurrency caps
- [ ] 1.2 Plan-as-fanout dashboard view

**Pillar 2 — LLM-agnostic** (0 / 2)
- [ ] 2.1 Per-task model overrides via labels / plan metadata
- [ ] 2.2 Execution adapters for credential-only providers

**Pillar 3 — Intelligent routing** (0 / 4)
- [ ] 3.1 Routing-rule editor UI
- [ ] 3.2 "Where would this run?" preview
- [ ] 3.3 Task-label authoring UI
- [ ] 3.4 Intelligent cutovers

**Pillar 4 — Autonomous loop** (0 / 6)
- [ ] 4.1 Self-review lifecycle state
- [ ] 4.2 Peer-review dispatch
- [ ] 4.3 Auto-merge gates
- [ ] 4.4 Agent persistent context
- [ ] 4.5 Attention queue / `requires_human_input` surface
- [ ] 4.6 Policy schema / trust dial

**Pillar 5 — Local-runtime-friendly** (3 / 4)
- [x] 5.1 Finish helper WSS connect/auth/register/heartbeat loop
- [x] 5.2 Local-machines dashboard view
- [x] 5.3 OpenClaw-via-helper adapter
- [ ] 5.4 Runner SDK / documented third-party contract

**Total: 3 / 18 gap areas closed.**

Per-gap scope doc links live in each per-pillar doc.

## Where the biggest gap is

**Pillar 4 (Autonomous loop with human-by-exception)** is the spine of
the product — the "user never comes back unless the agent says they
need to" promise — and it's the least built today. Self-review,
peer-review dispatch, auto-merge gates, agent persistent context,
attention queue, and the policy / trust-dial schema are all gaps. Most
have no scope doc yet. Closing Pillar 4 is the single largest delta to
v1.

**Pillar 5 (Local-runtime-friendly)** is largely shipped — 3 of 4
gap areas closed. The helper holds a stable WSS connection, the
`LocalRuntimesSection` UI surfaces connected machines, and the
OpenClaw-via-helper adapter ships. The remaining open gap is **5.4
Runner SDK / documented third-party contract** — no external SDK
exists yet for a third-party developer to add a new `Runner.*`
without modifying the helper.

Pillars 1, 2, and 3 are mostly "finish the UI and the polish edges"
rather than "design the system." The exception is **Pillar 3's new
gap area on intelligent cutovers** (fallback chains on rate-limit /
refusal, plus per-agent model-tier constraints), which has no scope
doc yet.

## Scope-doc layout reminder

- **Platform** scopes live under
  [`parallel-agent-platform/docs/active/`](https://github.com/kmgrassi/parallel-agent-platform/tree/main/docs/active)
  (in-flight) or `docs/shipped/` (merged) or `docs/reference/` (durable).
- **Runtime** scopes live under
  [`parallel-agent-runtime/docs/`](https://github.com/kmgrassi/parallel-agent-runtime/tree/main/docs)
  (flat, no shipped/ subdir).
- **Helper** scopes live under
  [`local-runtime-helper/docs/`](https://github.com/kmgrassi/local-runtime-helper/tree/main/docs).

Gap-area links below use absolute GitHub URLs so this doc reads
identically from any of the three repos.

## Maintenance contract

These docs are checklists. They only tell the truth if checkboxes get
flipped when work lands.

**When a PR ships the last piece of work for a gap area:**

1. **In the same PR** (or the final PR of a series), tick the box in
   this README's [Progress checklist](#progress-checklist) AND in the
   corresponding per-pillar doc.
2. **Cross-repo sync.** These vision-gaps docs are mirrored across
   `parallel-agent-platform`, `parallel-agent-runtime`, and
   `local-runtime-helper`. The tick must land in all three. Open
   companion docs-only PRs in the other repos if the implementation
   PR is in one repo, or pair them.
3. **Apply the repo's docs convention.** When ticking a box, also do
   the repo-specific scope-doc cleanup that marks the work as shipped:
   move platform scope docs from `docs/active/` to `docs/shipped/`,
   and update the runtime/helper flat `docs/` layouts in place.
4. **Update the counts.** Bump the `Closed: N / total` line in each
   per-pillar doc, the `Closed` column in the pillars table here, and
   the `Total: N / 18` line at the bottom of the progress checklist.

**Partial progress does NOT tick the box.** A gap area may have 8 of
12 PRs merged but still be open — keep the box clear until the gap
is *closed*. If you want partial visibility, link to the PR plan
from the per-pillar doc's gap-area section; the PR plan itself can
carry its own per-PR checkboxes.

**No emoji status indicators.** This file uses plain markdown task
lists (`- [ ]` / `- [x]`) so GitHub renders them natively as
checklists and they show up in the GitHub task-list UI. Don't add
🟢/🟡/⚪ status markers; the binary done/not-done is the contract.
