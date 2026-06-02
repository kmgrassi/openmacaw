# Local-Model End-to-End Readiness — Master Scoping Document

## Overview

The unified-tool-contract work has landed across runtime and helper:
tool registry, per-tool behaviour, provider adapters, unified
tool-calling loop, planner local relay client, manager local relay
client, per-agent manager scheduler topology, helper-side
`runtime_managed` mode (helper PRs #21, #22).

This document scopes the remaining work to make local-model agents —
**coding, planning, and manager** — work end-to-end against a real
helper deployment. Five items, in priority order:

| # | Gap | Priority | Repos |
|---|---|---|---|
| 1 | **Capability key mismatch** between runtime and helper | **Blocker** | runtime |
| 2 | **Platform UI** for routing planner/coding agents to local providers | High | platform |
| 3 | **Per-agent config scaffolding** for planner and coding (parity with manager — non-tool knobs only; tool policy is owned by [#363](https://github.com/kmgrassi/parallel-agent-platform/pull/363)) | Medium | runtime |
| 4 | **Production token validator** (DB-backed) | Medium | runtime, harper-server |
| 5 | **End-to-end smoke tests** for planner-on-local and manager-on-local | Medium | runtime |

## Why these five

Item 1 is the actual blocker. Today the runtime requires the helper
to advertise `manager_tool_calling: true` ([model_client/local_relay.ex:188](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/lib/symphony_elixir/manager/model_client/local_relay.ex#L188)),
but the helper advertises the agent-type-neutral `runtime_managed_tools: true`
(per the helper PR #20 scoping decision and PR #22 implementation in
`local-runtime-helper`). The two never match, so a real helper
connection fails with `:capability_missing` even though everything
else is wired. This must land before any other end-to-end work has a
chance to demonstrate value.

Items 2–5 are not blockers but each closes a real gap:
- **#2** lets users actually pick "local" for planner/coding agents in
  the UI. Without it, you can configure a manager via the existing
  `/settings/manager` page but have to hand-write workspace gateway
  config to point a planner or coding agent at a local model.
- **#3** brings parity. Manager agents have per-agent cadence
  ([#257](https://github.com/kmgrassi/parallel-agent-runtime/pull/257))
  and per-agent due-task filter
  ([#256](https://github.com/kmgrassi/parallel-agent-runtime/pull/256)).
  Planner and coding agents read workspace-only config today.
- **#4** unblocks production deployment. The dev-mode
  `LocalRelay.TokenValidator.Config` adapter only works with hashes
  injected via app env. A DB-backed adapter (referenced in
  [docs/local-model-e2e-scope.md](local-model-e2e-scope.md)) is
  required to ship beyond local development.
- **#5** is regression coverage. Coding has
  `local_model_smoke_test.exs`. Planner and manager don't, even though
  both now have local-model paths. A smoke test per agent type is the
  cheapest way to catch wire-shape regressions early.

## Cross-repo sequencing

```
runtime PR1 (capability rename) ──> END-TO-END WORKING for manager-on-local
                                              │
                                              ▼
runtime PR4 (smoke tests) ────────> regression coverage
                                              │
                                              ▼
runtime PR2 (per-agent scaffolding) ──> platform PR2 (per-agent UI)
                                              │
                                              ▼
platform PR1 (provider-selection UI) ──> users can configure local agents

runtime PR3 (token validator) ──> harper-server PR1 (token table) ──> prod readiness
```

PR1 is independent and unblocks everything else. PR4 should land
right after PR1 so the smoke tests verify PR1's fix in addition to
the existing coverage. PR2 and PR3 are independent.

## Per-repo PR plans

| Repo | Plan | PRs |
|---|---|---|
| `parallel-agent-runtime` | [local-model-readiness-runtime-prs.md](local-model-readiness-runtime-prs.md) | 4 |
| `parallel-agent-platform` | [local-model-readiness-platform-prs.md](local-model-readiness-platform-prs.md) | 2 |
| `harper-server` | [local-model-readiness-harper-prs.md](local-model-readiness-harper-prs.md) | 1 |

## Relationship to the agent tool data model overhaul

A separate cross-repo initiative ([parallel-agent-platform#363](https://github.com/kmgrassi/parallel-agent-platform/pull/363))
overhauls how agent tools are modelled. The current runtime contract is
documented in
[agent-tool-grant-data-model-runtime-scope.md](agent-tool-grant-data-model-runtime-scope.md):
`tool_policy_template` rows are write-time presets, and
`agent_tool_grant` rows are the effective source for model-facing tools.

This readiness scope is **orthogonal** to the tool overhaul:

- **Capability fix (runtime PR1)** — about the wire-protocol cap key,
  not tool resolution.
- **Provider selection UI (platform PR1)** — about
  `runners.<kind>.<agent_id>.{provider, model, credential_id}`. The
  tools an agent has are independent of which model it runs on.
- **Per-agent config scaffolding (runtime PR2)** — for non-tool
  runtime knobs (cadence, timeouts, custom instructions). Tool
  policy lives in the overhaul's normalized schema, not in
  `runners.<kind>.<agent_id>.<knob>`.
- **Per-agent settings UI (platform PR2)** — **dropped from this
  scope**. The tool-policy UI lives in the overhaul's PLAT-3.
  Non-tool per-agent settings UI can land later if and when concrete
  knobs are identified.
- **Token validator (runtime PR3 + harper PR1)** — about
  `local_runtime_token`, unrelated to tool policy.
- **Smoke tests (runtime PR4)** — should assert observable behaviour
  (tool calls round-trip, work items get snoozed) rather than
  internals, so they remain valid as the resolution path migrates.

If the overhaul ships before any item in this scope, no rework is
needed. If this scope ships first, the overhaul will adjust how
tools get into the dispatch frame but will not touch the readiness
items above.

## Related prior work

- [universal-tool-contract-scope.md](universal-tool-contract-scope.md)
  — master tool-contract design that landed across PRs #247–#256.
- [manager-local-model-scope.md](manager-local-model-scope.md) — the
  manager-on-local-model work that produced
  `Manager.ModelClient.LocalRelay`.
- [local-model-e2e-scope.md](local-model-e2e-scope.md) — earlier
  end-to-end scope; this doc supersedes its remaining open items.
- [manager-due-task-filter-scope.md](manager-due-task-filter-scope.md)
  — landed as PR #256.
