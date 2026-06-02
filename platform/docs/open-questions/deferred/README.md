# Deferred open questions

Questions parked here are real and unresolved — but **out of
scope for the current phase of work**. The current phase is:

- **Internal use only** (no external customers, no SaaS posture
  decisions needed yet).
- **Coding as the only vertical.** No video, design, ops, or
  browser verticals are being actively built. Per-vertical gate
  hooks and async-runner contracts are not on the critical path
  until we have a second vertical with a real customer.

Each deferred doc retains its full design (it took real thought
to write), so when the time comes to revisit, we have a starting
point and don't lose context.

## When to revisit each

| File | Revisit when… |
|---|---|
| [`oq-05-saas-posture.md`](./oq-05-saas-posture.md) | We're about to onboard a customer outside the team — i.e., before opening a private beta or shipping a `/waitlist` page |
| [`oq-09-runner-contract-non-coding.md`](./oq-09-runner-contract-non-coding.md) | We're starting on a non-coding vertical with a real customer (most likely candidates: video render, browser-batch automation) |
| [`oq-10-per-vertical-gate-hooks.md`](./oq-10-per-vertical-gate-hooks.md) | Same trigger as OQ-09 — gate hooks become real once we have a non-coding vertical that needs vertical-specific success criteria |

OQ-09 and OQ-10 are linked: starting a non-coding vertical is
the trigger for both. They should be revisited together.

OQ-05 is independent — it's gated on the business decision to
open up beyond the internal team, not on technical scope.

## Cross-references from active questions

A few active questions cross-reference these deferred docs.
Those references are preserved with the path
`./deferred/<file>.md` so the links don't break, and the link
text is suffixed `(deferred)` so a reader knows it's parked.
