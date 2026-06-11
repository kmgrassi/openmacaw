# Intelligent Cutovers + Router Agent — PR Plan

PR-level decomposition of the work scoped in
[`intelligent-cutovers-scope.md`](./intelligent-cutovers-scope.md)
(platform-side) and its runtime companion
[`intelligent-cutovers-runtime-scope.md`](../../../runtime/docs/intelligent-cutovers-runtime-scope.md),
**extended (2026-06-11) with the router agent** — a scheduled,
LLM-driven supervisor that tunes the deterministic routing config over
time.

This doc closes [vision-gap 3.4](../vision-gaps/03-intelligent-routing.md#34-intelligent-cutovers).

> **Note on staleness fixes (2026-06-11):** the original plan predated
> the monorepo merge. Repository references have been updated:
> `parallel-agent-platform` → `platform/`, `parallel-agent-runtime` →
> `runtime/`. DB migrations no longer land in `harper-server` — new
> OpenMacaw-owned schema changes live in `platform/supabase/migrations/`
> per platform CLAUDE.md, with reference SQL in
> `docs/supabase/openmacaw-schema.sql`.

## Goal

Two cooperating loops:

- **Fast loop (deterministic, in-task).** When a provider call fails
  with a cutover-eligible error (rate limit, overload, timeout, stream
  interruption, content refusal), the runtime walks a pre-declared
  fallback chain mechanically — no LLM in the hot path. This is the
  original cutover engine (PR1–PR11).
- **Slow loop (intelligent, scheduled).** A **router agent** — a
  regular agent created at workspace bootstrap, granted routing tools,
  and driven by a recurring scheduled task — periodically reads
  provider-failure history, cutover audit rows, transcripts, and the
  local-model registry, then **rewrites the deterministic config**:
  reorders fallback chains, switches an agent's primary to a cheaper
  local model, disables rules for chronically failing providers. Its
  optimization criteria are the scheduled task's user-editable
  `instructions` (e.g. "prefer my local machine for low-stakes tasks;
  never let the coding agent drop below mid-tier"). Every change it
  makes is a config write — audited and revertible.

The split keeps LLM judgment out of the failure path (fast, cheap,
predictable) while still getting adaptive behavior over time. Hard
constraints — most importantly the **adequacy floor** — are user-owned;
the router agent can edit chains and primaries but can never lower the
floor.

The plan covers 15 PRs:

- **Foundation** (registry, DB) — 2 PRs
- **Platform reads + runtime engine** (no call sites yet) — 2 PRs
- **Error classification** — 1 PR
- **Runner integration** (wiring the engine into provider call sites) — 3 PRs
- **Audit + dashboard** (visibility of cutover decisions) — 3 PRs
- **Router agent (slow loop)** — 3 PRs (failure history, routing tools,
  bootstrap + scheduled task)
- **Routing policy UI** — 1 PR

## Dependency graph

```
            FAST LOOP                                  SLOW LOOP
┌───────────────────────────────┐
│ PR1  platform                 │            ┌───────────────────────────────┐
│  Model-tier registry          │            │ PR13 runtime + platform       │
│  contracts/model-tiers.ts     │            │  provider_failure table +     │
└──────────────┬────────────────┘            │  event writes + read API      │
               │                             └──────────────┬────────────────┘
               ▼                                            │
┌───────────────────────────────┐                           │
│ PR2  platform (migrations)    │                           │
│  provider_cutover + M6/M7     │                           │
└──────────────┬────────────────┘                           │
       ┌───────┴────────┐                                   │
       ▼                ▼                                   │
PR3  platform      PR4  runtime                             │
 exec profile +     Cutover module +                        │
 routing reads      ModelTiers mirror                       │
       │                │                                   │
       │   ┌────────────┘                                   │
       │   ▼                                                │
       │ PR5  runtime — content-refusal classifier          │
       │   │                                                │
       │   ▼                                                │
       │ PR6  runtime — LlmToolRunner                       │
       │   ▼                                                │
       │ PR7  runtime — OpenClaw + ComputerUse + Codex      │
       │   ▼                                                │
       │ PR8  runtime + helper — LocalRelay + protocol      │
       │   ▼                                                │
       │ PR9  platform — audit repo + GET                   │
       │ PR10 runtime — audit row writes                    │
       │   ▼                                                │
       │ PR11 platform — WorkItemDetail fallback badge      │
       │                                                    │
       └──────────────┐                                     │
                      ▼                                     ▼
            ┌───────────────────────────────────────────────────┐
            │ PR14 platform + runtime                           │
            │  routing_rule.* agent tools + routing_rule_change │
            │  audit table (needs PR1, PR2, PR3)                │
            └──────────────────────┬────────────────────────────┘
                                   ▼
            ┌───────────────────────────────────────────────────┐
            │ PR15 platform                                     │
            │  Router agent bootstrap + scheduled task          │
            │  (needs PR13 + PR14)                              │
            └──────────────────────┬────────────────────────────┘
                                   ▼
            ┌───────────────────────────────────────────────────┐
            │ PR12 platform                                     │
            │  Routing policy UI: floor editor + chain view +   │
            │  change history (needs PR3, PR9, PR14)            │
            └───────────────────────────────────────────────────┘
```

Boxes that share a row can be reviewed and merged in parallel. PR13 is
independent of the entire fast loop and can land any time.

## Suggested PR Sequence

### PR1: Model-tier registry

Area: `platform/`

Scope:

- Add `contracts/model-tiers.ts` with `MODEL_TIERS`,
  `MODEL_TIER_REGISTRY` (all known providers + models from the
  cutover scope), and `modelTier()` lookup helper.
- Extend the cross-repo enum drift script
  (`scripts/check-cross-repo-enums.mjs`) to validate the registry
  against the routing-rule + credential CHECK constraints.
- Extend the schema-sync script
  (`scripts/append-supabase-jsdoc-types.mjs` or a sibling)
  to regenerate the runtime mirror at
  `runtime/apps/orchestrator/lib/symphony_elixir/model_tiers.ex` from
  `contracts/model-tiers.ts`. The actual `.ex` file lands in a
  separate runtime PR (PR4) that uses it.
- No DB change. No behavior change. Purely a registry + generator.

Acceptance:

- `tsc --noEmit` passes against the new contracts file.
- `modelTier("anthropic", "claude-opus-4-7")` returns `"frontier"`;
  `modelTier("openai_compatible", "qwen-2.5")` returns `"local"`
  via the wildcard entry.
- Cross-repo enum drift check passes.
- Unit tests cover the wildcard lookup behavior.

Parallelism:

- Blocks PR3 (the resolver wants `RegisteredProvider` from this
  file), PR4 (runtime cutover engine reads tiers), and PR14 (routing
  tools validate against the registry).
- Independent of PR2; can land in parallel.

---

### PR2: DB schema for cutover (M5 + M6 + M7)

Area: `platform/supabase/migrations/`

Scope:

- M5 migration: create `provider_cutover` audit table with
  workspace-scoped RLS using `public.is_workspace_member`, indexes
  on `(workspace_id, triggered_at DESC)` and `(work_item_id)`.
- M6 migration: create `routing_rule_fallback` join table + add
  `routing_rule.model_tier_floor` column with CHECK constraint.
  Fallback table's `provider` CHECK mirrors `routing_rule.provider`
  but excludes `bedrock` until PR8 in the adapter-rollout plan.
- M7 migration: drop `routing_rule.next_fallback_rule_id` (replaced
  by the M6 join table per the no-backwards-compat rule).
- Land as timestamped migration files under
  `platform/supabase/migrations/` with the matching reference SQL in
  `docs/supabase/openmacaw-schema.sql`; apply through the documented
  workflow in `docs/supabase/README.md`.

Acceptance:

- Migrations apply cleanly on a fresh database with the existing
  schema as of the most recent main.
- RLS policies use canonical helpers (`public.is_workspace_member`,
  `public.current_app_user_id`), not bare `auth.uid()`.
- No new entries in `routing_rule_fallback.provider` CHECK beyond
  what `routing_rule.provider` already permits.
- A grep for `routing_rule.next_fallback_rule_id` returns no
  callers in platform or runtime before the drop.

Parallelism:

- Independent of PR1. Can land in parallel.
- Blocks PR3 (platform code needs the columns to exist before
  reading them), PR9 (platform repo needs `provider_cutover`), and
  PR14 (routing tools write `routing_rule_fallback`).
- After merge: platform + runtime regenerate types via
  `pnpm run db:schema:sync` (platform) and the runtime schema-sync.
  Add `provider_cutover` and `routing_rule_fallback` to
  `BRIDGE_TABLES` in `scripts/append-supabase-jsdoc-types.mjs` on
  the runtime side (lands in PR4).

---

### PR3: Platform — execution profile + routing rule reads

Area: `platform/`

Scope:

- Extend `contracts/execution-profile.ts` with `fallbacks: []` and
  `modelTierFloor` fields (defaults preserve current behavior).
- Update `apps/api/src/repositories/routing-rules.ts` to:
  - Read `model_tier_floor` from `routing_rule`.
  - Join `routing_rule_fallback` ordered by `position` and emit as
    the `fallbacks` array on the resolved profile.
- Update `apps/api/src/services/execution-profile-resolver.ts` to
  populate the new fields.
- Validation: when reading a `routing_rule_fallback` link, look up
  its `(provider, model)` in `MODEL_TIER_REGISTRY` and reject the
  routing rule resolution if the tier classification is missing
  (fail closed).
- Update existing tests that consume `ExecutionProfile` to handle
  the new fields (default to empty array / `"any"`).

Acceptance:

- Routing rules with no fallback rows resolve identically to today
  (`fallbacks: []`, `modelTierFloor: "any"`).
- A routing rule with two fallback rows resolves with
  `fallbacks.length === 2` in `position` order.
- Resolver throws with a clear error code
  (`unknown_model_in_fallback_chain`) when a link references a
  `(provider, model)` not in the registry.
- `pnpm -C apps/api run validate` passes.

Parallelism:

- Depends on PR1 (uses `MODEL_TIER_REGISTRY` and
  `RegisteredProvider` type) and PR2 (needs the columns to exist).
- Independent of PR4 — they can be reviewed in parallel even
  though PR4 also needs PR1 + PR2.

---

### PR4: Runtime — Cutover module + cooldown ETS + ModelTiers mirror

Area: `runtime/`

Scope:

- Run the schema-sync (extended in PR1) to regenerate
  `apps/orchestrator/lib/symphony_elixir/model_tiers.ex`. Commit
  the regenerated file in this PR.
- Add `apps/orchestrator/lib/symphony_elixir/cutover.ex`:
  `Cutover.walk/3`, the `%CutoverLink{}` and `%CutoverDecision{}`
  structs, walk semantics matching the platform scope's behavior
  contract.
- Add `apps/orchestrator/lib/symphony_elixir/cutover/cooldown.ex`:
  ETS-backed cooldown table keyed by
  `(workspace_id, credential_id)`, 60s default for 429.
- Supervisor wiring for the GenServer in `application.ex`.
- Update the Elixir `ExecutionProfile` mirror to include
  `fallbacks` and `model_tier_floor` fields (via schema-sync).
- Add `provider_cutover` and `routing_rule_fallback` to
  `BRIDGE_TABLES` in
  `scripts/append-supabase-jsdoc-types.mjs`.
- Unit tests covering: floor skip, cooldown skip, success path,
  exhaustion, exhausted-by-floor.
- No call sites yet — this PR adds the module without wiring it
  into any runner.

Acceptance:

- `mix compile --warnings-as-errors` passes.
- `mix test test/symphony_elixir/cutover_test.exs` covers the walk
  semantics matrix.
- `ModelTiers.tier_of("anthropic", "claude-opus-4-7")` returns
  `:frontier`; cross-repo enum drift check still passes.
- Runtime startup smoke (`mix run --no-start -e ":ok"`) succeeds —
  no schema mismatch errors from the new bridge tables.

Parallelism:

- Depends on PR1 (registry source) and PR2 (DB columns + bridge
  tables).
- Blocks PR6, PR7, PR8.

---

### PR5: Runtime — content-refusal classification

Area: `runtime/`

Scope:

- Add `provider_content_refused` to
  `apps/orchestrator/lib/symphony_elixir/runner/observability.ex`
  `@retryable_provider_codes`.
- Add detection helpers in each runner's response parser:
  - LLM tool runner: detect Anthropic `refusal` blocks; detect
    OpenAI `finish_reason="content_filter"`.
  - OpenClaw / ComputerUse: detect content-policy 4xx responses.
  - Codex: detect refusal-shaped error payloads from the AppServer
    RPC.
- New tests in
  `test/symphony_elixir/runner/observability_test.exs` covering
  each detection helper.
- The new code is added but not yet triggered by the cutover
  engine — that wiring lands in PR6/7/8.

Acceptance:

- A simulated Anthropic refusal block round-trips through
  `Observability.provider_status_failure/2` and surfaces with
  `error_code: :provider_content_refused`, `retryable: true`.
- Same for `finish_reason="content_filter"` from OpenAI.
- `mix test` covers each detection helper.

Parallelism:

- Independent of PR1, PR2, PR3, PR4 — can land in parallel with
  any of them.
- Blocks PR6 (LLM tool runner wires the new code into its
  cutover-eligible set; without this PR the LLM runner can't trip
  on refusals).

---

### PR6: Runtime — wire Cutover into LLM tool runner

Area: `runtime/`

Scope:

- Refactor `apps/orchestrator/lib/symphony_elixir/runner/llm_tool_runner.ex:126`
  `model_client_create_response/3` to delegate provider call
  retries to `Cutover.walk/3`.
- The runner provides the per-link call closure; `Cutover.walk/3`
  drives.
- Implement a placeholder `Attention.escalate/3` (writes a
  `RuntimeLog` event of kind `attention_required` with the cutover
  decision payload). This is the OQ-CR-1 placeholder noted in the
  cutover runtime scope; the real implementation lands with the
  policy + attention queue work (separate PR plans).
- Integration test against a stubbed model client that returns a
  `provider_rate_limited` failure and a fallback link that
  succeeds.

Acceptance:

- An LLM tool runner turn whose primary model 429s continues
  against the next fallback link without dropping the turn.
- A turn whose entire chain exhausts logs the
  `attention_required` event with the cutover decision.
- Existing `llm_tool_runner` tests still pass.
- Walk respects the adequacy floor — a chain whose only remaining
  link is below the floor escalates rather than degrades.

Parallelism:

- Depends on PR4 (Cutover module) and PR5 (refusal detection).
- Blocks PR7 (shares the integration pattern; PR6's pattern should
  inform PR7's review).

---

### PR7: Runtime — wire Cutover into OpenClaw + ComputerUse + Codex

Area: `runtime/`

Scope:

- Bundled because all three runners share the same shape: catch
  failure → classify via Observability → delegate the retry to
  `Cutover.walk/3`. Per CLAUDE.md PR-bundling guidance, these
  three small integrations land together.
- `apps/orchestrator/lib/symphony_elixir/runner/openclaw.ex`:
  refactor `:84-100` HTTP POST path to delegate to
  `Cutover.walk/3`.
- `apps/orchestrator/lib/symphony_elixir/runner/computer_use.ex`:
  same shape as OpenClaw.
- `apps/orchestrator/lib/symphony_elixir/runner/codex.ex`: add a
  small `Codex.classify_error/1` helper that maps RPC error
  payloads to `Observability.ProviderFailure` shapes; wire through
  `Cutover.walk/3`.
- Integration tests per runner — small smoke each, since the
  walking logic is owned by PR4's test matrix.

Acceptance:

- Each of the three runners successfully walks a fallback chain
  on a simulated provider failure.
- Codex error classification handles at least 429-equivalent and
  5xx-equivalent RPC errors.
- No regressions in existing per-runner tests.

Parallelism:

- Depends on PR6 (pattern); PR6 must merge first so the review
  surface is consistent.
- Blocks PR8 (LocalRelay finishes the runner integration set).

---

### PR8: Runtime + Helper — LocalRelay integration + relay protocol error codes

Area: `runtime/` + `local-runtime-helper/`

Scope:

- **Helper side**: extend `internal/relay/protocol/` frame types so
  failure frames carry `error_code: provider_*` strings (mirror
  the runtime's `@retryable_provider_codes`).
- Helper `internal/runner/openai_compatible/`: classify local
  Ollama errors (HTTP 4xx/5xx, timeout, content refusal) and emit
  the canonical code in the failure frame.
- **Runtime side**:
  `apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex`
  parses the new failure-frame field; on failure, builds a
  `%ProviderFailure{}` and delegates to `Cutover.walk/3`.
- Update the relay-protocol doc
  (`runtime/docs/local-relay-protocol.md`) with the new
  failure-frame shape.

Acceptance:

- A simulated local model rate-limit causes the helper to emit a
  `provider_rate_limited` failure frame; the runtime LocalRelay
  receives it and walks the fallback chain identically to a cloud
  failure.
- Existing helper smoke tests
  (`go test ./internal/runner/...`) still pass.
- Existing runtime LocalRelay tests still pass.
- Relay protocol doc updated.

Parallelism:

- Depends on PR7 (consistent integration pattern across runners).
- Helper changes merge first (no consumer of the new field until
  the runtime parses it); runtime changes follow — or land both in
  one monorepo PR with the helper review as a prerequisite.

---

### PR9: Platform — provider_cutover repository + API endpoints

Area: `platform/`

Scope:

- Add `apps/api/src/repositories/provider-cutovers.ts` with:
  - `listForWorkItem(workItemId): Promise<ProviderCutover[]>`
  - `listRecentForWorkspace(workspaceId, limit, cursor): Promise<{items, nextCursor}>`
  - `create(input): Promise<ProviderCutover>`
- Add Zod schema in `contracts/provider-cutover.ts` (camelCase API
  shape).
- Add routes:
  - `POST /api/work-items/:id/cutovers`
  - `GET /api/work-items/:id/cutovers`
  - `GET /api/workspaces/:workspaceId/cutovers/recent`
- Tests: round-trip create, filter by work item, filter by recency.
- No UI yet — that's PR11/PR12.

Acceptance:

- POST accepts the runtime audit payload and persists one
  `provider_cutover` row scoped to the work item's workspace.
- GET endpoints return the audit rows that PR10 writes through the
  platform API.
- RLS prevents reading cutovers from another workspace.
- `pnpm -C apps/api run validate` passes.

Parallelism:

- Depends on PR2 (table must exist).
- Blocks PR11 (the badge consumes this endpoint) and feeds the
  router agent's read set (PR15 grants a read tool over it).
- Independent of PR3, PR4, PR5–PR8. Can be reviewed in parallel.

---

### PR10: Runtime — cutover audit row writes

Area: `runtime/`

Scope:

- Add `apps/orchestrator/lib/symphony_elixir/cutover/audit.ex`:
  `Cutover.Audit.write/1` posts to
  `/api/work-items/:id/cutovers` using the existing best-effort
  persistence pattern from
  [`best-effort-persistence-logging.md`](../../../runtime/docs/best-effort-persistence-logging.md).
- Wire `Cutover.walk/3` to emit an audit row at end of walk:
  one row per cutover decision (success or exhausted), with
  `outcome` correctly set to `fallback_succeeded` /
  `fallback_failed` (per intermediate link) / `escalated_floor` /
  `escalated_exhausted` / `skipped_no_adapter`.
- Tests: a stubbed platform endpoint receives the audit payload for
  each outcome and matches the PR9 request contract.

Acceptance:

- A successful cutover from primary → fallback link 1 writes one
  audit row with `outcome: fallback_succeeded`.
- A walk that skips an adapter-missing link records
  `outcome: skipped_no_adapter` for that link.
- Audit write failures are logged but do not fail the agent's
  turn (best-effort).

Parallelism:

- Depends on PR9 (the platform-owned POST endpoint and contract).
- Depends on PR4 (the engine to wire into) and PR6/7/8 (so audit
  writes happen at real call sites, not just unit tests).
- Blocks PR11 only because the badge needs real rows to look
  meaningful in QA. Functionally PR11 can land first against
  an empty table.

---

### PR11: Platform — WorkItemDetail "ran on fallback" badge

Area: `platform/`

Scope:

- Update `apps/web/src/pages/work-items/WorkItemDetail.tsx` (or
  equivalent) to fetch `GET /api/work-items/:id/cutovers` on load.
- Render a "Ran on fallback" badge when at least one cutover row
  exists for the work item, with a tooltip / drawer listing the
  primary → fallback transitions and triggering error codes.
- React Query integration (per the platform's
  `frontend-data-refresh-react-query-scope`).
- Tests: component renders correctly with 0, 1, and N cutover
  rows.

Acceptance:

- Work item with no cutovers shows no badge.
- Work item with cutovers shows the badge and the drawer renders
  the audit details.
- Existing WorkItemDetail tests still pass.

Parallelism:

- Depends on PR9 (read endpoint). Functionally independent of
  PR10 (the badge tolerates empty data).

---

### PR13: Runtime + Platform — provider-failure event persistence + read API

Area: `runtime/` + `platform/`

This is the router agent's primary sensor. Today provider failures
land only in stdout logs and loose `message.metadata` JSON. The
existing `event_log` table
(`platform/supabase/migrations/20260604133000_openmacaw_initial_schema.sql:194`)
is **not** reused here: its `work_item_id` and `source` columns are
non-null (provider failures can occur outside a work item — chat
turns, scheduled-task runs), and its data lives in a jsonb `payload`,
which conflicts with both the read API's need to group by
`(provider, model, error_code)` and the project rule against jsonb
for fields the application validates. A dedicated typed table is the
correct shape. This PR is a narrow, self-contained slice of the
broader end-to-end-logging plan
([`end-to-end-logging-improvement-pr-plan.md`](../../../runtime/docs/end-to-end-logging-improvement-pr-plan.md))
— coordinate so the two don't diverge on event shape.

Scope:

- **Migration** (`platform/supabase/migrations/`): create
  `provider_failure` table with typed columns — `id`, `created_at`,
  `workspace_id` (not null), `agent_id` / `work_item_id` / `run_id`
  (nullable — not every failure has all three), `runner_kind`,
  `provider`, `model`, `error_code`, `status_code` (nullable),
  `attempt`. Workspace-scoped RLS via `public.is_workspace_member`;
  index on `(workspace_id, created_at DESC)`. `provider` and
  `error_code` CHECKs mirror the existing enums.
- **Runtime**: extend `Observability.log_provider_failure/…` to also
  write a `provider_failure` row via the best-effort persistence
  pattern. Add `provider_failure` to `BRIDGE_TABLES` with the usual
  startup smoke test (runtime CLAUDE.md "Database Schema Sync —
  REQUIRED").
- **Platform**: add
  `apps/api/src/repositories/provider-failures.ts` and routes:
  - `GET /api/workspaces/:workspaceId/provider-failures/recent`
    (cursor-paginated raw rows)
  - `GET /api/workspaces/:workspaceId/provider-failures/summary?since=…`
    (counts grouped by `(provider, model, error_code)`)
- Zod contracts in `contracts/provider-failures.ts` (camelCase).
- Tests: a classified failure round-trips into `provider_failure` and
  out through both endpoints, including failures with no associated
  work item.

Acceptance:

- A simulated 429 in any runner produces one queryable
  `provider_failure` event row.
- The summary endpoint groups correctly and respects workspace RLS.
- Event-write failures never fail the agent turn (best-effort).
- `pnpm -C apps/api run validate` and `mix test` pass.

Parallelism:

- Independent of the entire fast loop (PR1–PR11) — can land first.
- Blocks PR15 (the router agent's instructions assume this data
  exists) and feeds PR14's `provider_failure.list` tool.

---

### PR14: Platform + Runtime — routing tools for agents + change audit

Area: `platform/` + `runtime/`

Gives agents a safe, audited tool surface over routing config, per
the tool CRUD conventions
([`tool-crud-conventions.md`](../reference/tool-crud-conventions.md)) —
contracts, API routes/services, runtime tool registry +
implementation, platform tool catalog, grant defaults, restricted
allowlists, tests, and prompts all land in this PR series.

Scope:

- **Migration** (`platform/supabase/migrations/`): create
  `routing_rule_change` audit table — `id`, `workspace_id`,
  `routing_rule_id`, `actor_agent_id`, `change_kind`
  (`primary_model` | `fallback_chain` | `enabled`), `old_provider` /
  `old_model` / `new_provider` / `new_model` (nullable), `reason`
  (required text — the agent's stated justification), `created_at`.
  Typed columns, not jsonb, per the project rule. Workspace-scoped
  RLS.
- **New tools** (snake_case CRUD shape):
  - `routing_rule.list` / `routing_rule.read` — current rules with
    fallback chains and floors, resolved per agent.
  - `routing_rule.update` — set primary `{provider, model,
    credentialRef}` and/or replace the ordered `fallbacks` array.
    **Hard guardrails enforced server-side, not by prompt:** cannot
    modify `model_tier_floor` (user-owned); every link must resolve
    in `MODEL_TIER_REGISTRY` (fail closed, same rule as PR3); every
    write requires `reason` and produces a `routing_rule_change`
    row. The agent MAY update its own routing rule (see OQ-RA-1 —
    self-rerouting is intended, e.g. moving itself to a newly
    capable local model), but a **no-self-brick validation** rejects
    any update that would leave the acting agent's own rule disabled
    or with zero resolvable links.
  - `provider_failure.list` — reads the PR13 summary/recent
    endpoints.
  - `local_model.list` — reads `local_runtime_machine` +
    `local_runtime_model` (machine status, advertised models) so the
    agent knows what is actually available on the user's machines.
  - `provider_cutover.list` — reads PR9's recent-cutovers endpoint.
- **Tool policy template**: add a `router` template bundling the
  five tools above plus the existing `scheduled_task.read`.
- Runtime: register implementations in `tool_registry.ex` (same
  pattern as `scheduled_task/tools.ex`).
- Tests: guardrail matrix (floor change rejected, unknown model
  rejected, missing reason rejected, self-brick update rejected,
  self-reroute to a valid chain accepted, happy-path update writes
  the audit row).

Acceptance:

- An agent granted the `router` template can read failures, models,
  cutovers, and rules, and update a rule's primary + chain.
- An attempted `model_tier_floor` change via the tool returns a
  structured error and writes nothing.
- Every successful mutation has a matching `routing_rule_change`
  row with the actor agent id and reason.
- Cross-repo enum drift check and `pnpm -C apps/api run validate`
  pass.

Parallelism:

- Depends on PR1 (registry validation), PR2 (`routing_rule_fallback`
  table), PR3 (resolver emits chains the tools read/write).
- Depends on PR13 only for the `provider_failure.list` tool — if
  sequencing demands, that one tool can ship inside PR13 instead.
- Blocks PR15 (bootstrap grants these tools) and PR12 (change
  history panel reads `routing_rule_change`).

---

### PR15: Platform — router agent bootstrap + scheduled task

Area: `platform/`

Makes the router agent a default per-workspace agent, the same way
Planning / Coding / Manager are bootstrapped today — and fixes the
"seed per workspace including future workspaces" gap that the
distillation migration seed has (it only covered workspaces existing
at migration time).

Scope:

- Add `apps/api/src/services/setup/store/router-agent.ts` with
  `ensureWorkspaceRouterAgent()` — deterministic agent id (same
  derivation pattern as `manager-agent.ts`), `agent_type: "router"`,
  name "Router Agent", tool policy from the PR14 `router` template.
- Call it from `listSetupAuthState()` in
  `apps/api/src/services/setup/default-agents.ts` alongside the
  existing ensures. Because this path runs on every login, existing
  workspaces get the router agent on their next `GET /api/auth/state`
  — no backfill migration needed.
- Ensure (idempotently, keyed on `metadata.kind =
  "router_optimization"`) a recurring scheduled task targeting the
  router agent — default twice daily, `{ kind: "every", interval:
  12, unit: "hour" }`, delivery `scheduled_agent_message`. The task's
  `instructions` are the **user-editable optimization criteria**,
  seeded with a default template along the lines of: review provider
  failures, cutover outcomes, and local-model availability since the
  last run; rewrite fallback chains and primaries to maximize task
  success first, then prefer cheaper/local models where the floor
  allows; explain every change via the tool's `reason` field; change
  nothing if the data doesn't justify it. The ensure must not
  overwrite user edits to `instructions` or `schedule` — only create
  when missing.
- The router agent runs on the workspace's configured execution
  profile like any other agent (no hardcoded model, per platform
  CLAUDE.md).
- Tests: fresh-workspace bootstrap creates agent + task; second call
  is a no-op; user-edited instructions survive re-ensure.

Acceptance:

- A new signup ends up with four default agents — Planning, Coding,
  Manager, Router — and one `router_optimization` scheduled task.
- An existing workspace gains both on next `GET /api/auth/state`.
- Editing the task's instructions in the UI persists across
  subsequent logins.
- A manual `run-now` of the task produces a router-agent run that
  reads via the PR14 tools (verified against a stubbed history).

Parallelism:

- Depends on PR14 (tools + template) and PR13 (failure data worth
  reading).
- Blocks nothing — PR12 benefits from real `routing_rule_change`
  rows but doesn't require them.

---

### PR12: Platform — routing policy UI: floor editor + chain view + change history

Area: `platform/`

Re-scoped from the original "full chain builder" — the router agent
is now the primary author of fallback chains, so the UI's job shifts
to **owning the floor, seeing the current policy, and reviewing what
the router agent changed**, with manual override as the escape hatch.

Scope:

- Update the routing-rule editor surface
  (`apps/web/src/pages/settings/…`) with:
  - **Adequacy floor select**: `any` / `local` / `mid` / `frontier`.
    This is the user-owned control the router agent cannot touch.
  - **Chain view**: the current primary + ordered fallback chain per
    agent, read from the resolver (PR3 fields), with tier badges
    from `MODEL_TIER_REGISTRY`. Manual edit (add / remove / reorder)
    stays available as an override; provenance label shows whether
    the current chain was last written by the user or the router
    agent.
  - **Change history panel**: `routing_rule_change` rows (PR14) —
    who (user / router agent), what, when, and the stated reason.
    Link each entry to related `provider_cutover` rows where
    relevant.
  - **Model picker** filtered by provider, populated from
    `MODEL_TIER_REGISTRY`; **credential picker** reuses
    `apps/web/src/components/settings/CredentialPicker.tsx`.
- Editor validations:
  - Warn if `modelTierFloor: frontier` but the primary is mid-tier.
  - Warn if a link references a not-yet-executable provider (link to
    the adapter-rollout scope).
- React Query integration; tests for render, save round-trip,
  validations, and history rendering with 0/1/N change rows.

Acceptance:

- A user can set the floor and see/override the current chain; the
  read-back matches what the API resolves.
- The history panel shows router-agent changes with reasons.
- Floor warnings are advisory, not blocking (the cutover engine
  enforces the floor at walk time).

Parallelism:

- Depends on PR3 (resolver fields), PR9 (cutover read endpoint),
  PR14 (`routing_rule_change` table).
- Independent of PR11 — both touch web UI but different surfaces.

## Cross-PR Guardrails

- **No `routing_rule.next_fallback_rule_id` references** anywhere in
  platform or runtime code after PR2 lands. Grep in CI; fail if
  found.
- **No new uses of jsonb for cutover or routing-change state** — the
  `fallbacks` data lives in the `routing_rule_fallback` table; the
  cutover audit lives in `provider_cutover`; router-agent changes
  live in `routing_rule_change`; provider-failure events live in
  `provider_failure` — all with typed columns. This is also why PR13
  does not reuse `event_log` (jsonb payload, non-null
  `work_item_id`). Push back on any jsonb-shaped alternative per the
  project rule.
- **The adequacy floor is user-owned.** Enforced in two independent
  places: the cutover walker skips below-floor links at run time
  (PR4), and the `routing_rule.update` tool rejects floor mutations
  at write time (PR14). The router agent's prompt also says so, but
  the prompt is not the enforcement mechanism.
- **Router-agent writes are always audited.** `routing_rule.update`
  requires a `reason` and writes `routing_rule_change`
  unconditionally — there is no unaudited mutation path exposed to
  agents.
- **Self-rerouting is allowed; self-bricking is not.** The router
  agent may rewrite its own routing rule (OQ-RA-1), but
  `routing_rule.update` rejects any update that would leave the
  acting agent's own rule disabled or with zero resolvable links.
  Its runtime resilience comes from the fast loop — its own rule
  carries a fallback chain like any agent's.
- **Bridge-table list**: when adding `provider_cutover` and
  `routing_rule_fallback` to `BRIDGE_TABLES` (PR4), include a
  smoke test that confirms the runtime's `SupabaseSchema` module
  loads them at startup (runtime CLAUDE.md "Database Schema Sync —
  REQUIRED").
- **Cross-repo enum drift check** runs on every platform PR. New
  providers added to the cutover registry but not to the
  `routing_rule.provider` CHECK (or vice versa) fail CI.
- **OQ-CR-1 placeholder**: the `Attention.escalate/3` placeholder
  introduced in PR6 will be replaced by the real implementation
  when the
  [policy-trust-dial-runtime-scope](../../../runtime/docs/policy-trust-dial-runtime-scope.md)
  R-2 phase lands. PR6 should mark the placeholder with a
  `# TODO(4.6): replace with Attention.escalate` comment.
- **Provider adapter dependency**: the cutover audit's
  `skipped_no_adapter` outcome surfaces when a fallback link
  references a provider whose execution adapter has not shipped
  (see
  [provider-execution-adapter-rollout](./provider-execution-adapter-rollout-scope.md)).
  PR10's tests should cover this outcome explicitly. The PR14 tool
  should likewise warn (not reject) when the router agent adds a
  link for an adapter-less provider.

## First Slice Recommendation

Land **PR1 (registry)**, **PR2 (DB schema)**, and **PR13
(failure-event persistence)** in parallel as the foundation — PR13 has
no dependencies and starts accumulating the history the router agent
will need from day one.

Then **PR3 (platform reads)** and **PR4 (runtime engine + mirror)** in
parallel. The first user-visible fast-loop behavior is **PR6** (LLM
tool runner walks a chain on a real 429).

The first slow-loop slice is **PR14 + PR15** — at that point a new
workspace has a Router Agent that wakes daily, reads real failure
history, and tunes the chains the fast loop executes. Aim for PR1–PR6 +
PR13 in the first iteration; PR14/PR15 in the second; audit + UI
(PR9–PR12) fast-follow.

## Open Questions

Fast-loop OQs reference the platform scope's OQ-CU-* and the runtime
scope's OQ-CR-* lists; router-agent OQs are new (OQ-RA-*).

- **OQ-CR-1** (Attention.escalate placeholder) — resolved by the
  policy-trust-dial PR plan, not this one. PR6 ships the
  placeholder.
- **OQ-CR-2** (per-orchestrator vs per-workspace cooldown) — PR4
  ships per-orchestrator. Revisit if Redis-backed cooldown becomes
  necessary.
- **OQ-CU-3** (cost tracking on cutover) — out of scope here; defer
  to OQ-04. Note the router agent would benefit directly from
  per-call cost data when weighing "cheaper local model" decisions;
  revisit priority once PR15 is live.
- **OQ-CU-5** (wildcard registry entries) — PR1 ships the wildcard
  pattern for `openai_compatible`. Other providers must list
  models explicitly.
- **OQ-RA-1** (can the router agent reroute itself) — **DECIDED
  2026-06-11: yes.** Self-rerouting is intended behavior — e.g. when
  a local model becomes capable enough, the router agent moves its
  own rule to the cheaper model. The failure mode this raised ("its
  provider is down so it can't run to fix itself") is handled by the
  fast loop, not by a write restriction: the router agent's own rule
  carries a fallback chain like any agent's, so the deterministic
  cutover walk keeps it runnable when its primary provider fails.
  The remaining guardrail is narrow: the `routing_rule.update` tool
  rejects a self-update that would leave the agent's own rule
  disabled or with zero resolvable links (no self-bricking, enforced
  in PR14). If its entire chain still exhausts, that escalates to
  the attention path like any other exhaustion.
- **OQ-RA-2** (apply vs propose) — **DECIDED 2026-06-11:
  auto-apply, no user approval step.** Changes are audited
  (`routing_rule_change` with reasons) and revertible, and the floor
  is enforced server-side. If the
  [policy-trust-dial-scope](./policy-trust-dial-scope.md) later
  wants to offer propose-for-approval as an opt-in, that's a
  follow-up — not part of this plan.
- **OQ-RA-3** (cadence) — **DECIDED 2026-06-11: twice daily**
  (every 12 hours). A failure-triggered wake (e.g. N failures within
  an hour schedules an immediate run via `scheduled_task.run_now`)
  is a natural follow-up once PR13's event stream exists; out of
  scope for this plan.
