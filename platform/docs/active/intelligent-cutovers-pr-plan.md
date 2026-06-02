# Intelligent Cutovers — PR Plan

PR-level decomposition of the work scoped in
[`intelligent-cutovers-scope.md`](./intelligent-cutovers-scope.md)
(platform-side) and its runtime companion
[`intelligent-cutovers-runtime-scope.md`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/intelligent-cutovers-runtime-scope.md).
DB migrations land via
[`harper-server/docs/vision-gaps-migrations-scope.md`](https://github.com/harper-hq/harper-server/blob/main/docs/vision-gaps-migrations-scope.md)
(M5, M6, M7).

This doc closes [vision-gap 3.4](../vision-gaps/03-intelligent-routing.md#34-intelligent-cutovers).

## Goal

Land the cutover engine + audit + UI through 12 reviewable PRs that
build on each other in a clear dependency order. Where adjacent PRs
touch the same files or must merge together to ship value, they're
bundled per the runtime CLAUDE.md PR-bundling guidance. Where they
have independent rollout risk or different review surfaces, they
stay split.

The plan covers:

- **Foundation** (registry, DB) — 2 PRs
- **Platform reads + runtime engine** (no call sites yet) — 2 PRs
- **Error classification** — 1 PR
- **Runner integration** (wiring the engine into provider call sites) — 3 PRs
- **Audit + dashboard** (visibility of cutover decisions) — 3 PRs
- **Editor UI** — 1 PR

## Cross-repo dependency graph

```
                       ┌───────────────────────────────┐
PR1  platform          │  Model-tier registry          │
                       │  contracts/model-tiers.ts     │
                       └──────────────┬────────────────┘
                                      │ unblocks resolver typing
                                      ▼
PR2  harper-server     ┌───────────────────────────────┐
                       │  DDL: provider_cutover + M6/M7│
                       └──────────────┬────────────────┘
                                      │ schema sync
                  ┌───────────────────┴───────────────────┐
                  ▼                                       ▼
PR3  platform     PR4  runtime
   exec profile +    Cutover module +
   routing reads     ModelTiers mirror
                  │                                       │
                  │ profile shape ready                   │ engine ready
                  └───────────────────┬───────────────────┘
                                      ▼
PR5  runtime          ┌───────────────────────────────┐
                      │  Content-refusal classifier   │
                      └──────────────┬────────────────┘
                                     │ all triggers detected
                                     ▼
                  ┌───────────────────┴───────────────────┐
                  ▼                                       ▼
PR6  runtime       PR7  runtime
   LlmToolRunner      OpenClaw + ComputerUse + Codex
                  │                                       │
                  └───────────────────┬───────────────────┘
                                      ▼
PR8  runtime + helper ┌───────────────────────────────┐
                      │  LocalRelay + protocol codes  │
                      └──────────────┬────────────────┘
                                     ▼
                  ┌───────────────────┴───────────────────┐
                  ▼                                       ▼
PR9  platform       PR10 runtime
   audit repo + GET     audit row writes
                  │                                       │
                  └───────────────────┬───────────────────┘
                                      ▼
PR11 platform         ┌───────────────────────────────┐
                      │  WorkItemDetail fallback badge│
                      └──────────────┬────────────────┘
                                     ▼
PR12 platform         ┌───────────────────────────────┐
                      │  Routing-rule editor: chain + │
                      │  floor builder                │
                      └───────────────────────────────┘
```

Boxes that share a row can be reviewed and merged in parallel.

## Suggested PR Sequence

### PR1: Model-tier registry

Repository: `parallel-agent-platform`

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
  `apps/orchestrator/lib/symphony_elixir/model_tiers.ex` from
  `contracts/model-tiers.ts`. The actual `.ex` file lands in a
  separate runtime PR (PR4) that uses it.
- No DB change. No behavior change. Purely a registry +
  generator.

Acceptance:

- `tsc --noEmit` passes against the new contracts file.
- `modelTier("anthropic", "claude-opus-4-7")` returns `"frontier"`;
  `modelTier("openai_compatible", "qwen-2.5")` returns `"local"`
  via the wildcard entry.
- Cross-repo enum drift check passes.
- Unit tests cover the wildcard lookup behavior.

Parallelism:

- Blocks PR3 (the resolver wants `RegisteredProvider` from this
  file) and PR4 (runtime cutover engine reads tiers).
- Independent of PR2; can land in parallel.

---

### PR2: DB schema for cutover (M5 + M6 + M7)

Repository: `harper-server`

Scope:

- M5 migration: create `provider_cutover` audit table with
  workspace-scoped RLS using `public.is_workspace_member`, indexes
  on `(workspace_id, triggered_at DESC)` and `(work_item_id)`.
- M6 migration: create `routing_rule_fallback` join table + add
  `routing_rule.model_tier_floor` column with CHECK constraint.
  Fallback table's `provider` CHECK mirrors `routing_rule.provider`
  but excludes `bedrock` until PR8 in the adapter-rollout plan
  (which is the M8 migration in this scope's terminology).
- M7 migration: drop `routing_rule.next_fallback_rule_id` (replaced
  by the M6 join table per the no-backwards-compat rule).
- Run `supabase db push --dry-run` and
  `supabase db push --include-all --dry-run` per harper-server
  CLAUDE.md.

Acceptance:

- Dry-run migrations apply cleanly on a fresh database with the
  existing schema as of the most recent harper-server main.
- RLS policies use canonical helpers (`public.is_workspace_member`,
  `public.current_app_user_id`), not bare `auth.uid()`.
- No new entries in `routing_rule_fallback.provider` CHECK beyond
  what `routing_rule.provider` already permits.
- A grep for `routing_rule.next_fallback_rule_id` returns no
  callers in platform or runtime before the drop.

Parallelism:

- Independent of PR1. Can land in parallel.
- Blocks PR3 (platform code needs the columns to exist before
  reading them) and PR9 (platform repo needs `provider_cutover`).
- After merge: platform + runtime regenerate types via
  `pnpm run db:schema:sync` (platform) and
  `pnpm run supabase:schema:sync` (runtime). Add
  `provider_cutover` and `routing_rule_fallback` to
  `BRIDGE_TABLES` in `scripts/append-supabase-jsdoc-types.mjs` in
  the runtime side (lands in PR4).

---

### PR3: Platform — execution profile + routing rule reads

Repository: `parallel-agent-platform`

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

Repository: `parallel-agent-runtime`

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

Repository: `parallel-agent-runtime`

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

Repository: `parallel-agent-runtime`

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

Repository: `parallel-agent-runtime`

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

Repository: `parallel-agent-runtime` + `local-runtime-helper`
(cross-repo PR pair)

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
- Update relay-protocol doc
  (`parallel-agent-runtime/docs/local-relay-protocol.md`) with the
  new failure-frame shape.

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
- Cross-repo coordination: helper PR merges first (no consumer of
  the new field until runtime parses it); runtime PR follows.
  Could alternatively land as a single PR per repo opened
  simultaneously with the helper PR review being a prerequisite.

---

### PR9: Platform — provider_cutover repository + API endpoints

Repository: `parallel-agent-platform`

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
- No UI yet — that's PR11.

Acceptance:

- POST accepts the runtime audit payload and persists one
  `provider_cutover` row scoped to the work item's workspace.
- GET endpoints return the audit rows that PR10 writes through the
  platform API.
- RLS prevents reading cutovers from another workspace.
- `pnpm -C apps/api run validate` passes.

Parallelism:

- Depends on PR2 (table must exist).
- Blocks PR11 (the badge consumes this endpoint).
- Independent of PR3, PR4, PR5–PR8. Can be reviewed in parallel.

---

### PR10: Runtime — cutover audit row writes

Repository: `parallel-agent-runtime`

Scope:

- Add `apps/orchestrator/lib/symphony_elixir/cutover/audit.ex`:
  `Cutover.Audit.write/1` posts to
  `/api/work-items/:id/cutovers` using the existing best-effort
  persistence pattern from
  [`best-effort-persistence-logging.md`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/best-effort-persistence-logging.md).
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

Repository: `parallel-agent-platform`

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

### PR12: Platform — routing rule editor with fallback chain + floor builder

Repository: `parallel-agent-platform`

Scope:

- Update `apps/web/src/pages/settings/RoutingRules.tsx` (or the
  current editor location) with:
  - **Fallback chain builder**: ordered list of
    `{provider, model, credential}` rows. Add / remove / reorder
    via drag handle.
  - **Adequacy floor select**: `any` / `local` / `mid` /
    `frontier` dropdown.
  - **Model picker**: dropdown of models filtered by selected
    provider; populated from `MODEL_TIER_REGISTRY`.
  - **Credential picker**: reuses
    `apps/web/src/components/settings/CredentialPicker.tsx`.
- Editor validations:
  - Warn if `modelTierFloor: frontier` but the primary is a
    mid-tier model (e.g. `claude-haiku-4-5`).
  - Warn if a fallback link references a not-yet-executable
    provider (link to the adapter-rollout scope).
- Save flow: POST `/api/workspaces/:id/routing-rules` with the
  inline `fallbacks` and `modelTierFloor` (the API endpoint maps
  to `routing_rule_fallback` rows on the backend; that mapping
  may need a small API-side change here too).
- Tests: editor renders, save round-trips, validations fire.

Acceptance:

- A user can build a 3-link fallback chain through the UI and
  save it; reading the routing rule back via the API shows the
  same chain.
- Setting `modelTierFloor: frontier` on a rule whose primary is
  mid-tier triggers a warning, not a blocking error (warnings
  are advisory — the cutover engine enforces the floor at walk
  time).
- The model picker shows models filtered to the selected
  provider, drawing from the registry.

Parallelism:

- Depends on PR3 (resolver emits the new fields).
- Independent of PR11 — both touch web UI but different surfaces.
- Largest single PR in this plan (~600 lines); consider splitting
  the chain builder and the model picker if review velocity
  matters.

## Cross-PR Guardrails

- **No `routing_rule.next_fallback_rule_id` references** anywhere in
  platform or runtime code after PR2 lands. Grep in CI on
  parallel-agent-platform and parallel-agent-runtime for any
  references; fail if found.
- **No new uses of jsonb for cutover state** — the `fallbacks`
  data lives in the `routing_rule_fallback` table; the audit lives
  in `provider_cutover`. If a future PR is tempted to add a
  `cutover_*` column with jsonb shape, push back per the project
  rule against jsonb for fields the application validates.
- **Bridge-table list**: when adding `provider_cutover` and
  `routing_rule_fallback` to `BRIDGE_TABLES` (PR4), include a
  smoke test that confirms the runtime's `SupabaseSchema` module
  loads them at startup. Otherwise the
  `function_clause` runtime crashes (runtime CLAUDE.md "Database
  Schema Sync — REQUIRED") catch this only at boot.
- **Cross-repo enum drift check** runs on every platform PR. New
  providers added to the cutover registry but not to the
  `routing_rule.provider` CHECK (or vice versa) fail CI.
- **OQ-CR-1 placeholder**: the `Attention.escalate/3` placeholder
  introduced in PR6 will be replaced by the real implementation
  when the
  [policy-trust-dial-runtime-scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/policy-trust-dial-runtime-scope.md)
  R-2 phase lands. PR6 should mark the placeholder with a
  `# TODO(4.6): replace with Attention.escalate` comment so the
  follow-up PR is easy to find.
- **Provider adapter dependency**: the cutover audit's
  `skipped_no_adapter` outcome surfaces when a fallback link
  references a provider whose execution adapter has not shipped
  (Gemini, Mistral, etc. before the
  [provider-execution-adapter-rollout](./provider-execution-adapter-rollout-scope.md)
  PRs land). PR10's tests should cover this outcome explicitly
  so we don't regress when adapters do land and start exercising
  these chains.

## First Slice Recommendation

Land **PR1 (registry)** and **PR2 (DB schema)** in parallel as the
foundation. Both are small, independent, and unblock the rest of
the plan.

Then land **PR3 (platform reads)** and **PR4 (runtime engine + mirror)**
in parallel. PR3 is a contract + repo change; PR4 is the runtime
GenServer + cooldown.

The first slice that actually changes user-visible behavior is
**PR6 (wire Cutover into LLM tool runner)** — that's when a
fallback chain starts mattering for real agent turns. Aim for PR1–PR6
in the first 2-week iteration. Audit + UI (PR9–PR12) can fast-follow
once the engine is live.

## Open Questions

These reference the platform scope's OQ-CU-* and the runtime scope's
OQ-CR-* lists; nothing new added here. The PR plan does not pre-empt
those decisions — each PR lands with the tentative answer noted in
the scope docs, and a follow-up PR amends if needed.

- **OQ-CR-1** (Attention.escalate placeholder) — resolved by the
  policy-trust-dial PR plan, not this one. PR6 ships the
  placeholder.
- **OQ-CR-2** (per-orchestrator vs per-workspace cooldown) — PR4
  ships per-orchestrator. Revisit if Redis-backed cooldown becomes
  necessary.
- **OQ-CU-3** (cost tracking on cutover) — out of scope here; defer
  to OQ-04.
- **OQ-CU-5** (wildcard registry entries) — PR1 ships the wildcard
  pattern for `openai_compatible`. Other providers must list
  models explicitly.
