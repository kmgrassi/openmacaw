# Local-Model Readiness — Runtime PR Plan

Repo: `parallel-agent-runtime`.

See [local-model-readiness-scope.md](local-model-readiness-scope.md) for
the master design and cross-repo sequencing.

---

## PR1 — Fix capability key mismatch with helper

**Branch:** `fix/manager-runtime-managed-capability`

**Goal:** Replace the legacy `manager_tool_calling` capability
requirement with the agent-type-neutral `runtime_managed_tools` that
the helper advertises in [`local-runtime-helper/internal/relay/client.go`](https://github.com/kmgrassi/local-runtime-helper/blob/main/internal/relay/client.go).

**Why this is the blocker:** the helper merged the rename in PR #22
per the scoping decision in helper PR #20. The runtime side was never
updated. A real helper connection fails capability negotiation with
`{:fatal, :capability_missing}` because the helper never advertises
`manager_tool_calling`. Test fixtures stub whichever key the runtime
expects, so CI is green while production is broken.

**Files:**

| File | Change |
|---|---|
| `apps/orchestrator/lib/symphony_elixir/manager/model_client/local_relay.ex` | Line 188: `Map.put_new("manager_tool_calling", true)` → `Map.put_new("runtime_managed_tools", true)` |
| `apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex` | Audit `capability_requirements/1` (~line 269); ensure no other component still defaults to `manager_tool_calling`. |
| `apps/orchestrator/lib/symphony_elixir/planner/model_client/local_relay.ex` | Add `Map.put_new("runtime_managed_tools", true)` to the planner's capability requirements (it currently sets none — confirm this is intentional or also requires the cap). |
| `apps/orchestrator/test/symphony_elixir/runner/manager_test.exs` | Lines 275, 388: replace `capabilities: %{manager_tool_calling: true}` → `%{runtime_managed_tools: true}`. |
| `apps/orchestrator/test/symphony_elixir/runner/manager_test.exs` | Line 333: replace `"capability_requirements" => %{"manager_tool_calling" => true}` → `%{"runtime_managed_tools" => true}` in the dispatch frame assertion. |
| `apps/orchestrator/test/...` (planner local relay tests, if any) | Update to assert `runtime_managed_tools` if PR also touches planner. |

**Acceptance criteria:**
- [ ] `grep -r "manager_tool_calling" apps/orchestrator` returns zero
  matches outside changelog/scoping docs.
- [ ] Manager local-relay tests pass with the new key.
- [ ] Documented in commit message: this is the second half of the
  helper PR #22 rename; the runtime now matches the wire contract.

**Sequencing:** Independent. Land first.

**Size:** ~10 lines source + ~5 lines tests.

---

## PR2 — Per-agent runtime config scaffolding for planner and coding agents

**Branch:** `feat/planner-coding-per-agent-config`

**Scope: non-tool runtime knobs only.** Tool policy is owned by the
agent tool data model overhaul ([parallel-agent-platform#363](https://github.com/kmgrassi/parallel-agent-platform/pull/363))
and the runtime contract in
[agent-tool-grant-data-model-runtime-scope.md](agent-tool-grant-data-model-runtime-scope.md):
`tool_policy_template` rows are write-time presets, and
`agent_tool_grant` rows are the effective source for model-facing
tools. This PR is for runtime knobs that don't fit that model: cadence
overrides, provider/model/credential selection, timeouts, custom
instructions, rate limits.

**Goal:** Bring planner and coding agents to parity with the manager's
per-agent gateway-config keying. Manager reads
`runners.manager.<agent_id>.<knob>` first, then
`runners.manager.<knob>`. Planner and coding read workspace-only
config today. This PR adds the scaffolding so future per-agent
runtime knobs land in a consistent place.

**This PR does not add specific user-facing knobs.** It adds the
config-reading helper, the agent-id-aware lookup pattern, and tests
that the fallback semantics work. Concrete knobs come in follow-up
PRs once they're identified.

**Files:**

| File | Change |
|---|---|
| `apps/orchestrator/lib/symphony_elixir/planner/session_resolver.ex` (or equivalent — confirm location) | Add `agent_config(workspace_id, agent_id, key)` helper that reads `runners.planner.<agent_id>.<key>` first, then `runners.planner.<key>`, then a default. |
| `apps/orchestrator/lib/symphony_elixir/runner/local_model_coding.ex` | Same scaffold for `runners.local_model_coding.<agent_id>.<key>` (the runtime config schema and execution-profile allowlist key the coding runner as `local_model_coding`, not `coding`). |
| `apps/orchestrator/test/symphony_elixir/planner/session_resolver_test.exs` | Tests for resolution priority. |
| `apps/orchestrator/test/symphony_elixir/runner/local_model_coding_test.exs` | Tests. |

**Reference pattern:** [`Manager.Scheduler.configured_min_cadence_ms/2`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex)
and [`configured_due_task_query/2`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex)
in the manager scheduler.

**Acceptance criteria:**
- [ ] Helper function exists and is unit-tested for both planner and
  coding paths.
- [ ] `runners.planner.<agent_id>.<key>` overrides
  `runners.planner.<key>`.
- [ ] Workspace-only config continues to work for agents without an
  override (no behaviour change for existing deployments).
- [ ] Doc comment on the helper points future contributors at this
  scoping doc and notes that knobs should be added incrementally as
  the platform UI exposes them.

**Sequencing:** Independent. Can run parallel to PR1 and PR4.

**Size:** ~80 lines source + ~60 lines tests.

---

## PR3 — Production-grade token validator (DB-backed adapter)

**Branch:** `feat/local-relay-db-token-validator`

**Goal:** Replace the dev-only env-based token validator with a
DB-backed adapter for production. Today
[`LocalRelay.TokenValidator.Config`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/lib/symphony_elixir/local_relay/token_validator.ex)
checks `local_relay_token_hashes` in app env. Production needs to
validate against `harper-server`'s `local_runtime_token` table (added
in `harper-server` PR1, see scoping in
[local-model-readiness-harper-prs.md](local-model-readiness-harper-prs.md)).

**Files:**

| File | Change |
|---|---|
| `apps/orchestrator/lib/symphony_elixir/local_relay/token_validator/database.ex` (new) | Implements the `TokenValidator` behaviour by querying `local_runtime_token` via PostgREST. Validates: hash matches, `revoked_at IS NULL`, optional `expires_at` not yet past, `workspace_id` matches the connecting client. Updates `last_seen_at` on success (best-effort, async). |
| `apps/orchestrator/lib/symphony_elixir/local_relay/token_validator.ex` | Update default adapter selection: `:database` in `:prod`, `:config` in `:dev` and `:test`. |
| `apps/orchestrator/config/prod.exs` | Set adapter to the database variant. |
| `apps/orchestrator/test/symphony_elixir/local_relay/token_validator/database_test.exs` (new) | Tests against a stubbed PostgREST client (hit, miss, revoked, expired, workspace-mismatch). |
| `apps/orchestrator/priv/generated/postgrest-schema.json` | Regenerated after harper-server PR1 — `local_runtime_token` columns must be present. |
| `scripts/append-supabase-jsdoc-types.mjs` | Add `local_runtime_token` to `BRIDGE_TABLES` if not already there. |

**Acceptance criteria:**
- [ ] Database adapter validates against the live `local_runtime_token`
  table.
- [ ] Revoked, expired, workspace-mismatched, and unknown tokens all
  return `{:error, :invalid_token}` with distinguishable error reasons
  in the log.
- [ ] `last_seen_at` updates on every successful validation
  (best-effort, doesn't block the connection).
- [ ] Dev-mode env adapter remains the default in `:dev` and `:test`.
- [ ] `pnpm run supabase:schema:sync` after harper-server PR1 produces
  the bridge metadata for `local_runtime_token`.

**Sequencing:** Depends on `harper-server` PR1 (token table schema).
Independent of runtime PRs 1, 2, 4.

**Size:** ~150 lines source + ~120 lines tests.

---

## PR4 — End-to-end smoke tests for planner-on-local and manager-on-local

**Branch:** `test/planner-manager-local-smoke`

**Goal:** Coding has
[`local_model_smoke_test.exs`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/test/symphony_elixir/runner/local_model_coding_smoke_test.exs)
which runs an in-process loop end-to-end with a mocked OpenAI
endpoint. Planner and manager don't have equivalent tests, so a wire
regression on those paths surfaces only in production.

**Files:**

| File | Change |
|---|---|
| `apps/orchestrator/test/symphony_elixir/integration/planner_local_smoke_test.exs` (new) | Stubs the local-relay registry and a model HTTP endpoint, dispatches a planner turn, asserts the model receives provider-format tool specs, asserts a `task.create` tool call round-trips, asserts the planner emits the expected events. |
| `apps/orchestrator/test/symphony_elixir/integration/manager_local_smoke_test.exs` (new) | Same shape for manager: scheduler tick → local helper dispatch → tool call request (`snooze` or `dispatch_runner`) → tool result → completion. Verifies capability negotiation succeeds with `runtime_managed_tools: true` (depends on PR1). |

**Reference for stub patterns:** the existing
`local_model_coding_smoke_test.exs` and the test doubles in
`scheduler_test.exs` (`TestRepo`, `TestManager`, `TestSessionResolver`,
`TestGatewayConfig`).

**Acceptance criteria:**
- [ ] Both smoke tests run in <5s and don't require network or a real
  helper binary.
- [ ] Capability negotiation is exercised end-to-end (the manager
  smoke test would fail before PR1 lands and pass after).
- [ ] Tests cover the happy path **and** at least one failure path
  (e.g. `local_runtime_offline`) so regressions to error handling
  surface.

**Sequencing:** Land after PR1 so the manager smoke can use the new
capability key. Independent of PR2 and PR3.

**Size:** ~250 lines per smoke test = ~500 lines total.

---

## Sequencing summary

```
PR1 ─┬─> production manager-on-local works
     └─> PR4 (smoke tests use new capability key)

PR2 (independent — scaffolding only)

PR3 (depends on harper-server PR1)
```

## Validation (per CLAUDE.md, required before each commit)

```bash
cd apps/orchestrator
mix compile --warnings-as-errors
mix test
```
