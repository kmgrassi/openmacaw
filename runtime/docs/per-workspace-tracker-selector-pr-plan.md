# Per-Workspace Tracker Selector — Runtime PR Plan

Operational checklist for the runtime work that consumes
`workspace_settings.tracker_kind`. Pair this with the original scope
doc `docs/per-workspace-tracker-selector-scope.md` (already merged)
for full design rationale.

## Status legend

| Status | Meaning |
|---|---|
| 🟢 Ready to start | No upstream deps; pick up now |
| 🟡 Blocked | Has a prerequisite still in flight |
| ✅ Shipped | Merged into main |

## PRs in this repo

### 🟢 RUNTIME-1 — Thread `workspace_id` through every Tracker callback

**What.** Behavior-preserving plumbing. Every `@callback` in
`apps/orchestrator/lib/symphony_elixir/tracker.ex` (`fetch_candidate_issues`,
`fetch_issues_by_states`, `fetch_issue_states_by_ids`, `create_comment`,
`update_issue_state`) gets `workspace_id` as the first argument.
Every adapter in `tracker/*.ex` is updated to accept the new arg
(Memory can ignore it; Database starts filtering by it). Callers
(orchestrator, BrokerLog, tests) are updated.

In this PR `Tracker.adapter(workspace_id)` **still** returns the
global `Config.settings!().tracker.kind` adapter — the per-workspace
lookup lands in `RUNTIME-2`. The point is to plumb the parameter
without changing behaviour.

**Prerequisites.** None.

**Independent.** Yes.

**Validation.** `cd apps/orchestrator && mix compile
--warnings-as-errors && mix test`.

**Unblocks.** `RUNTIME-2`, `RUNTIME-3`.

---

### 🟡 RUNTIME-2 — `Tracker.adapter(workspace_id)` reads `workspace_settings`

**What.** Replace the global `Config.settings!().tracker.kind`
lookup with a per-workspace read of `workspace_settings.tracker_kind`
via PostgREST. Fall back to `database` when no row exists (matches
the `workspace_settings` lazy-row convention). Cache the resolved
adapter as a single value on `Orchestrator.State` since each
orchestrator instance owns one workspace (see `RUNTIME-3` for why).
TTL ~30s plus an explicit invalidation hook for the `RUNTIME-4`
planner tool to call.

**Prerequisites.** `RUNTIME-1` (callback signatures) and harper-server
`HARPER-1` (the `tracker_kind` column).

**Independent.** No — both upstream PRs must land first.

**Validation.** Unit test: workspace W1 with
`workspace_settings.tracker_kind = "linear"` resolves to Linear
adapter; W2 with no row falls back to Database adapter. Cache
invalidation: after a write through the invalidation hook,
subsequent `Tracker.adapter(W)` returns the new adapter without
waiting for TTL. Negative: `tracker_kind = "linear"` with
`tracker_credential_id = null` returns
`{:error, {:missing_tracker_credential, "linear"}}`.

**Unblocks.** `RUNTIME-3`, `RUNTIME-4`, platform `PLATFORM-CUTOVER-1`.

---

### 🟡 RUNTIME-3 — Resolve the instance's own workspace at startup

**What.** Each orchestrator instance reads its workspace_id from
`stored_agent.workspace_id` at startup (already present in launcher
config via `Orchestrator.Starter`/`build_stored_agent_config`,
`orchestrator/starter.ex:236`) and stores it on
`Orchestrator.State`. The poll tick calls
`Tracker.fetch_candidate_issues(state.workspace_id)` — **does not
enumerate workspaces**. Codex flagged the enumerate-all approach on
the original scope: per-process `running`/`claimed` guards would
race across instances.

Add a negative case that fails fast (raises or returns
`{:error, :missing_workspace_id}`) when launch config omits
`stored_agent.workspace_id` — the missing scope is the bug, not
something to paper over.

**Prerequisites.** `RUNTIME-1` + `RUNTIME-2`.

**Validation.** Two-instance integration test: O1 launched with
W1 (database), O2 with W2 (memory). Each instance only sees and
dispatches its own workspace's items. No item dispatched twice.
BrokerLog records the correct `tracker_kind` per run.

**Unblocks.** `RUNTIME-5`, platform `PLATFORM-CUTOVER-1`.

---

### 🟡 RUNTIME-4 — Planner tool `workspace_settings.update_tracker_kind`

**What.** New planner tool registered in
`apps/orchestrator/lib/symphony_elixir/tool_registry.ex` under
`apps/orchestrator/lib/symphony_elixir/planner/tools/`. Arguments:
`tracker_kind` (enum sourced from harper-server CHECK constraint)
and `credential_id` (required when kind is `linear` or `github`).
Writes to `workspace_settings` via PostgREST, invalidates the
`RUNTIME-2` cache for that workspace, returns the resulting row.
Bundle: `:planner` (and possibly `:manager` if managers should be
able to switch the tracker).

**Prerequisites.** `RUNTIME-2`.

**Validation.** Unit test: tool call writes the row and invalidates
the cache. Negative: invalid `tracker_kind` value rejected at the
tool layer before the write.

**Unblocks.** Nothing in the runtime — purely user-facing.

---

### 🟡 RUNTIME-5 — Cutover: remove boot-time `config.tracker.kind`

**What.** Delete `config.tracker.kind` from `config/schema.ex` and
`config.ex` validation. `Tracker.adapter/0` (zero-arity) is removed.
All callers go through `Tracker.adapter(workspace_id)`. Update
CLAUDE.md to reflect the new contract. No backwards-compat shim.

**Prerequisites.** `RUNTIME-1..4` in production, and confidence that
the UI + planner tool can switch the kind for any workspace that
still relies on the boot-time default.

**Validation.** Full `mix test`. Smoke test: start an orchestrator
with no boot-time tracker config; agent in a workspace with
`tracker_kind = "memory"` runs successfully.

**Unblocks.** Nothing — the final step.

## Cross-repo dependencies

| When this repo's PR is ready, the upstream PRs must be merged: |
|---|
| `RUNTIME-1` — none |
| `RUNTIME-2` — harper-server `HARPER-1` (`tracker_kind` column) |
| `RUNTIME-3` — `RUNTIME-1`, `RUNTIME-2` |
| `RUNTIME-4` — `RUNTIME-2` |
| `RUNTIME-5` — `RUNTIME-1..4` in production |

| What this repo's PRs unblock in other repos: |
|---|
| `RUNTIME-2` in prod → platform `PLATFORM-CUTOVER-1` and `PLATFORM-CUTOVER-2` |
| `RUNTIME-3` in prod → platform `PLATFORM-CUTOVER-1` |

## Reference

- Original scope: `docs/per-workspace-tracker-selector-scope.md` (this repo).
- Platform scope: `parallel-agent-platform/docs/active/per-workspace-tracker-selector-scope.md`.
- Harper-server scope: `harper-server/docs/per-workspace-tracker-selector-scope.md`.
- Harper-server PR plan: `harper-server/docs/per-workspace-tracker-selector-pr-plan.md`.
- Platform PR plan: `parallel-agent-platform/docs/active/per-workspace-tracker-selector-pr-plan.md`.
