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

| # | Pillar | Today | Doc |
|---|---|---|---|
| 1 | Parallel by default | Mostly shipped | [01-parallel-by-default.md](01-parallel-by-default.md) |
| 2 | LLM-agnostic | Mostly shipped | [02-llm-agnostic.md](02-llm-agnostic.md) |
| 3 | Intelligent routing | Foundations shipped, UI thin | [03-intelligent-routing.md](03-intelligent-routing.md) |
| 4 | Autonomous loop | **Biggest gap** | [04-autonomous-loop.md](04-autonomous-loop.md) |
| 5 | Local-runtime-friendly | In flight | [05-local-runtime-friendly.md](05-local-runtime-friendly.md) |

## Where the biggest gap is

**Pillar 4 (Autonomous loop with human-by-exception)** is the spine of
the product — the "user never comes back unless the agent says they
need to" promise — and it's the least built today. Self-review,
peer-review dispatch, auto-merge gates, webhook-in surface, attention
queue, and the policy / trust-dial schema are all gaps. Most have no
scope doc yet. Closing Pillar 4 is the single largest delta to v1.

**Pillar 5 (Local-runtime-friendly)** is the second-largest gap by
surface area, but most of it is in flight — the helper repo exists,
the relay protocol is designed, and finishing it is a matter of
completing the OQ-02 PR sequence rather than designing new systems.

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
