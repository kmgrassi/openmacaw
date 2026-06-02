# Per-Workspace Tracker Selector — Platform PR Plan

Operational checklist for the platform-side work. Pair this with the
original scope doc
`docs/active/per-workspace-tracker-selector-scope.md` (already
merged; an update in PR #552 adds the cutover-phase items captured
below).

## Status legend

| Status | Meaning |
|---|---|
| 🟢 Ready to start | No upstream deps; pick up now |
| 🟡 Blocked | Has a prerequisite still in flight |
| ✅ Shipped | Merged into main |

## PRs in this repo

### 🟢 PLATFORM-0 — Add Linear + GitHub to credential provider registry

**What.** Today `contracts/provider-registry.ts`'s
`CREDENTIAL_PROVIDER_IDS` and `PROVIDER_REGISTRY` only know about
model providers (`openai`, `anthropic`, `xai`, `google`, etc.). The
tracker selector relies on selecting a credential with
`provider = "linear"` or `provider = "github"`, but those providers
don't exist in the registry yet.

Add `linear` and `github` to `CREDENTIAL_PROVIDER_IDS` and the
`PROVIDER_REGISTRY` with `modelCatalog`, `execution`, `manager` flags
set to **false** so model-resolution code never picks them. Update
`apps/api/src/routes/credentials.ts` validation to recognize the new
providers (their secret is just an API key/PAT; reuse the existing
"API key" credential shape). If the DB has a `credential.provider`
CHECK constraint that excludes these, ship a sibling harper-server
PR (probably not — credential.provider is text without CHECK).

**Prerequisites.** None.

**Independent.** Yes.

**Validation.** `pnpm -C apps/api run validate`. Contract test
asserts `CREDENTIAL_PROVIDER_IDS` includes both new values.

**Unblocks.** `PLATFORM-2` (UI credential picker filters by these
provider IDs).

---

### 🟡 PLATFORM-1 — `workspace_settings.tracker_kind` API endpoints

**What.** New routes in `apps/api/src/routes/`:

- `GET /api/workspace/:id/settings` — returns the current
  `workspace_settings` row, falling back to column defaults when no
  row exists.
- `PATCH /api/workspace/:id/settings/tracker` — body
  `{ trackerKind, trackerCredentialId? }`. Validates the credential
  exists and is workspace-scoped before writing.

New contract `contracts/tracker-kinds.ts` (mirror of
`contracts/runner-kinds.ts`) sourced from the generated
`workspace_settings.tracker_kind` CHECK values. New repository
helper `apps/api/src/repositories/workspace-settings.ts`. Both use
`assertSupabaseSuccess()` per the surface-errors rule. Snake_case at
the DB boundary, camelCase at the API boundary per the
case-conventions rule.

**Prerequisites.** harper-server `HARPER-1` (so the column exists and
generated types are available). Can start contract scaffolding in
parallel; can't complete until `HARPER-1` is merged and types are
regenerated.

**Validation.** Unit/contract tests for read defaults, update writes,
credential workspace-membership validation, and
missing-credential-for-kind error. `pnpm -C apps/api run validate`.

**Unblocks.** `PLATFORM-2`.

---

### 🟡 PLATFORM-2 — Settings → Work Tracker UI panel

**What.** New panel in the workspace-settings route alongside the
existing settings UI. Tracker-kind dropdown with descriptions. When
`linear` or `github` is selected, render a credential picker
filtered to that provider (reuses the existing credential management
UI once `PLATFORM-0` adds the provider IDs to the registry). Save
button calls `PATCH .../settings/tracker`. Banner: "Changes take
effect within ~30s (runtime cache TTL)."

**Prerequisites.** `PLATFORM-0` (provider registry) and `PLATFORM-1`
(API).

**Validation.** `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`.
Browser smoke per CLAUDE.md "Testing — REQUIRED For UI/Frontend
Changes."

**Unblocks.** Nothing structural — user-facing only.

---

### 🟢 PLATFORM-3 — Cross-repo enum drift check for `tracker_kind`

**What.** Extend `scripts/check-cross-repo-enums.mjs` to also assert
`workspace_settings.tracker_kind` CHECK ⊇ platform
`TrackerKind` enum ⊇ runtime `@supported_tracker_kinds`. Update the
CI workflow `.github/workflows/cross-repo-enum-drift.yml` if new
file paths are added.

**Prerequisites.** None of the implementation PRs — this is the
guardrail that protects them. Can ship in parallel with `PLATFORM-0`
and `PLATFORM-1`.

**Independent.** Yes.

**Validation.** Run the drift script locally; should pass against
current main.

---

### 🟡 PLATFORM-CUTOVER-1 — Stop writing per-agent `config_json.tracker`

**What.** Remove the `tracker` defaults from
`defaultAgentGatewayConfig` and `repairManagerGatewayConfig` (the
latter's defaults were added in #551 as a band-aid). Remove the
`buildGatewayConfig` and `repairGatewayConfig` paths that derive
`tracker` from `SetupRequest.tracker`. Keep readers tolerant of the
field still being present on legacy rows; the runtime side
(`RUNTIME-2/3`) will be ignoring `config_json.tracker` by then.

**Prerequisites.** runtime `RUNTIME-2` and `RUNTIME-3` **in
production**. Pre-merging this PR before the runtime side is live
would break agent launch.

**Validation.** Tests covering both writers should be updated to no
longer assert tracker presence in the output.

**Unblocks.** `PLATFORM-CUTOVER-2`.

---

### 🟡 PLATFORM-CUTOVER-2 — One-off migration script: derive per-workspace `tracker_kind` from existing agent rows

**What.** New script in `scripts/` (idempotent, re-runnable, with a
`--dry-run` flag). For each workspace, walks the agents'
`gateway_config.config_json.tracker.kind` values and:

1. If all agents agree, hoists the value into
   `workspace_settings.tracker_kind`.
2. If they disagree (rare), picks the planning/coding agent's value
   as canonical and logs a one-off warning rather than failing.
3. After upsert, optionally nulls out `config_json.tracker` for the
   workspace's agent rows (gated behind a separate flag — leaving
   the field present on legacy rows is fine and reversible).

**Prerequisites.** harper-server `HARPER-1`, runtime `RUNTIME-2/3` in
production, `PLATFORM-CUTOVER-1` merged so new writes don't keep
producing per-agent tracker rows.

**Validation.** `--dry-run` against a staging or sandbox database
listing every workspace and the value it would write. Idempotency
test: running twice produces the same end state.

## Cross-repo dependencies

| When this repo's PR is ready, the upstream PRs must be merged: |
|---|
| `PLATFORM-0` — none |
| `PLATFORM-1` — harper-server `HARPER-1` |
| `PLATFORM-2` — `PLATFORM-0`, `PLATFORM-1` |
| `PLATFORM-3` — none (guardrail; parallel with implementation) |
| `PLATFORM-CUTOVER-1` — runtime `RUNTIME-2/3` in production |
| `PLATFORM-CUTOVER-2` — harper-server `HARPER-1`; runtime `RUNTIME-2/3` in production; `PLATFORM-CUTOVER-1` |

| What this repo's PRs unblock in other repos: |
|---|
| `PLATFORM-0` in prod → no direct downstream; enables `PLATFORM-2`'s credential picker. |
| `PLATFORM-1` in prod → no direct downstream (`RUNTIME-2` reads via PostgREST, not the platform API). |

## Reference

- Original scope: `docs/active/per-workspace-tracker-selector-scope.md` (this repo; PR #552 adds the cutover sections).
- Runtime scope: `parallel-agent-runtime/docs/per-workspace-tracker-selector-scope.md`.
- Harper-server scope: `harper-server/docs/per-workspace-tracker-selector-scope.md`.
- Runtime PR plan: `parallel-agent-runtime/docs/per-workspace-tracker-selector-pr-plan.md`.
- Harper-server PR plan: `harper-server/docs/per-workspace-tracker-selector-pr-plan.md`.
