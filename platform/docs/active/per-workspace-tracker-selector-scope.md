# Per-Workspace Tracker Selector — Platform Scope

Companion to:

- `parallel-agent-runtime/docs/per-workspace-tracker-selector-scope.md`
- `harper-server` scope doc (same filename)

## Premise

Today every orchestrator process runs a single tracker kind chosen at
boot time. Users cannot pick "store work items in Linear" or "use GitHub
Issues" without redeploying. This scope adds a per-workspace selector
exposed via:

- a settings UI (this doc),
- a planner agent tool (runtime doc), and
- a `workspace_settings.tracker_kind` column (harper-server doc).

All three converge on the same row. The runtime resolves the kind on
every Tracker call.

## Current State

- `workspace_settings` exists (harper-server migration #531/#536), one
  row per workspace, with `learning_enabled` today and a documented
  pattern for adding new typed columns as workspace-scoped knobs join.
- The platform has a credential store (`credential` table, already
  workspace-scoped) that is **currently scoped to model providers
  only**. `contracts/provider-registry.ts` defines
  `CREDENTIAL_PROVIDER_IDS` as `openai | anthropic | xai | google |
  mistral | groq | openrouter | together | perplexity | azure |
  openai_codex` — Linear and GitHub are **not** in this set today.
  The `/api/credentials` route validates against this list, and the
  DB has a matching allowlist. Reusing the credential table for
  tracker credentials is the right call, but it requires extending
  the provider registry before the tracker UI can read or write
  them.
- The platform has no tracker-related UI today.

## Target State

- A **Workspace Settings → Work Tracker** panel where the user picks a
  tracker kind from a typed dropdown.
- For `linear` and `github`, a credential picker reuses the existing
  credential management UI (same pattern as model credentials).
- The save flow writes to `workspace_settings.tracker_kind` and
  `workspace_settings.tracker_credential_id` and surfaces a clear
  success/error state.
- The runtime resolves the kind on every Tracker call; latency to take
  effect is bounded by the RUNTIME-2 cache TTL (~30s).

## Phased Work (Parallelizable)

Four platform PRs. PLATFORM-0 (credential-provider extension) is a
prerequisite for the credential picker in PLATFORM-2 — it can ship
independently and in parallel with the harper-server migration.
PLATFORM-1 is independent of the harper-server migration (uses
generated types after they regen); PLATFORM-2 gates on PLATFORM-0 and
PLATFORM-1.

### PLATFORM-0 — Add Linear And GitHub To The Credential Provider Registry

Today `contracts/provider-registry.ts` only knows about model
providers. The tracker UI relies on selecting credentials with
`provider = "linear"` or `provider = "github"`, so those provider IDs
have to land in the registry and the DB allowlist first. Concretely:

- Extend `PROVIDER_REGISTRY` in `contracts/provider-registry.ts` with
  `linear` and `github` entries. These do **not** participate in
  `modelCatalog`/`execution`/`manager` flows — set the relevant flags
  false so model-resolution code never picks them.
- Add `linear` and `github` to `CREDENTIAL_PROVIDER_IDS`.
- Define what shape the credential takes for each:
  - `linear`: API key + optional team filter. Reuse the existing
    "API key" credential shape (same as model providers).
  - `github`: personal access token + repository selector (org/repo
    string list, possibly stored in a sibling typed column on
    `credential` or in its existing JSONB blob — pick whichever the
    existing credential schema already supports for non-model
    providers; do not invent a parallel store).
- Update `/api/credentials` create/list/validate paths to recognize
  the new providers (route handler in `apps/api/src/routes/credentials.ts`
  or wherever the credentials route lives). The model-provider
  validation should not run for tracker credentials — credential
  validation needs a small branch on `provider`.
- Update any DB-level allowlist (`credential.provider` CHECK in
  harper-server, if one exists) to include the new values. If a
  harper-server migration is required, file it as a companion to
  this PR; otherwise note in the PR body that the DB already accepts
  these values.

**Independent**: can ship in parallel with the harper-server
`workspace_settings` migration.

### PLATFORM-1 — Contracts + API Endpoints

- Add to `contracts/`: a `TrackerKind` zod enum sourced from the
  generated `workspace_settings.tracker_kind` CHECK constraint values
  (do not hardcode; pull from `supabase/generated/types.ts` once
  harper-server migration lands). Likely a new
  `contracts/tracker-kinds.ts` mirroring the pattern of
  `contracts/runner-kinds.ts`.
- Add API routes in `apps/api/src/routes/`:
  - `GET /api/workspace/:id/settings` — returns the current
    `workspace_settings` row, falling back to defaults when no row
    exists (matches the lazy-row convention).
  - `PATCH /api/workspace/:id/settings/tracker` — body:
    `{ trackerKind, trackerCredentialId? }`; validates the credential
    exists and is workspace-scoped before writing.
- Use `assertSupabaseSuccess()` from `lib/supabase-errors.ts` per the
  CLAUDE.md surface-errors rule.
- Repositories: `apps/api/src/repositories/workspace-settings.ts` for
  the read/write helpers. Snake_case at the DB boundary, camelCase at
  the API boundary per the case-conventions rule.

**Gates on**: harper-server migration merging (for types regen).
**Can start**: contract scaffolding and route handlers in parallel,
swap mocked types for generated once available.

### PLATFORM-2 — Settings UI

- New panel in the workspace settings route, alongside the existing
  workspace settings UI.
- Dropdown of tracker kinds. Each option shows a short description
  ("Database — Supabase-backed canonical store", "Linear — your Linear
  workspace", "GitHub — repository issues", "Memory — in-memory, for
  development", "API — external push").
- When the user selects `linear` or `github`, render a credential
  picker filtered to credentials of the matching provider (once
  PLATFORM-0 has added those providers to the registry, the existing
  credential picker can filter by them with no additional changes).
- Save button calls `PATCH /api/workspace/:id/settings/tracker`.
- Show a banner: "Changes take effect within ~30 seconds (runtime
  cache TTL)."
- Validation: disable Save when `linear`/`github` is selected without a
  credential. Surface a clear "no Linear/GitHub credentials in this
  workspace yet — add one in Credentials settings" empty state with a
  deep link to the existing credentials UI.

**Gates on**: PLATFORM-0 (for the credential picker), PLATFORM-1
(for the read/write endpoints).

### PLATFORM-3 — Drift Check Extension

- Extend `scripts/check-cross-repo-enums.mjs` to also assert
  `workspace_settings.tracker_kind` CHECK ⊇ platform `TrackerKind` enum
  ⊇ runtime `@supported_tracker_kinds` (matching the existing
  `runner_kind` invariant pattern).
- Update the CI workflow `.github/workflows/cross-repo-enum-drift.yml`
  if new file paths are added.

**Gates on**: harper-server migration; can run in parallel with
PLATFORM-1/2 otherwise.

## Test Cases

### Unit: settings dropdown renders supported kinds

```
given:  the contracts/tracker-kinds.ts enum
when:   the settings panel renders
then:   the dropdown shows exactly the kinds in the enum (no extras,
        no missing values)
and:    each option has a description string
```

### Unit: credential picker gates on kind

```
given:  the user selects tracker_kind = "linear"
when:   the panel renders
then:   the credential picker becomes visible, filtered to provider=linear
and:    the Save button is disabled until a credential is chosen
```

### API contract: read defaults when no row exists

```
given:  workspace W has no workspace_settings row
when:   GET /api/workspace/W/settings
then:   200 with body { trackerKind: "database", trackerCredentialId: null,
                        learningEnabled: true, ... }
        (defaults sourced from column defaults, not hardcoded)
```

### API contract: update writes the row

```
given:  workspace W with no row
when:   PATCH /api/workspace/W/settings/tracker
        body: { trackerKind: "linear", trackerCredentialId: C }
        where C is a credential belonging to W with provider=linear
then:   200, and a workspace_settings row exists with the new values
```

### API contract: credential validation

```
given:  workspace W, credential C2 belongs to a different workspace
when:   PATCH .../settings/tracker with trackerCredentialId = C2
then:   400 invalid_credential, no DB write
```

```
given:  PATCH with trackerKind = "linear", trackerCredentialId = null
then:   400 missing_credential_for_kind, no DB write
```

### Integration: end-to-end UI save

```
given:  authenticated user in workspace W
when:   user opens settings, selects "Linear", picks credential,
        clicks Save
then:   UI shows success state with the "changes in ~30s" banner
and:    GET /api/workspace/W/settings reflects the new values
```

### Browser smoke

Manual smoke:

1. Log in with dev credentials per CLAUDE.md.
2. Open Workspace Settings → Work Tracker. Confirm dropdown shows
   memory, database, github, api, linear.
3. Select "Linear", confirm credential picker appears. Pick a Linear
   credential (or create one inline if the existing flow supports it).
   Save.
4. Open the planner chat. Ask it to create a plan with one task.
5. Wait ~30 seconds. Confirm the new work item appears in Linear (or
   broker logs show tracker_kind=linear for the run).
6. Switch back to "Database". Repeat the planner prompt. Confirm the
   new work item appears in `work_items`.

## Migration Considerations From Current Per-Agent Tracker Storage

Added 2026-05-21 after discovering production manager-agent launch
failures (see PR #551). The findings affect implementation phasing,
not the target design.

### What we discovered

The platform's `repairManagerGatewayConfig` writer was producing
`gateway_config.config_json` rows for manager agents that **omitted
`tracker` entirely** on first write — only `{ runners: { manager:
{...} } }`. The runtime launcher rejects any agent whose
`config_json` lacks `tracker.kind` (per
`apps/orchestrator/lib/symphony_elixir/launcher/agent_starter.ex`
`tracker.kind is required`), so manager agents in workspaces created
through that path could never launch.

Planning/coding agents weren't affected — `defaultAgentGatewayConfig`
seeds `tracker: { kind: "database", table: "work_items" }` from the
start.

PR #551 closed the gap by defaulting `tracker` (and
`workflow_template`) in `repairManagerGatewayConfig` when the
existing config doesn't already carry them. Existing broken rows
were hand-patched.

### Implications for this scope

1. **The band-aid in #551 is transient.** Once
   `workspace_settings.tracker_kind` is the authoritative source
   (this scope's target state), per-agent `gateway_config.tracker`
   becomes either deprecated entirely or a per-agent override of the
   workspace default. Either way the manager-writer default added in
   #551 should be removed as part of the cutover so we don't ship
   two sources of tracker truth.
2. **Existing rows are heterogeneous.** Some rows have
   `tracker.kind = "database"`, some have `tracker.kind = "memory"`
   (older workspaces), some had no `tracker` at all until #551
   patched them. Migration to `workspace_settings.tracker_kind`
   needs to decide per workspace: if all agents in a workspace agree
   on `tracker.kind`, hoist that value; if they disagree (rare but
   possible), pick the planning/coding agent's value as canonical
   and log a one-off warning rather than failing silently.
3. **The strict runtime validation is the right behavior to keep.**
   The reason this bug got debugged in minutes was that the launcher
   loudly rejects missing `tracker.kind`. When the runtime is changed
   in RUNTIME-2 / RUNTIME-3 to read from `workspace_settings`,
   preserve the strict-rejection posture: if a workspace has no
   `workspace_settings.tracker_kind` resolvable, fail with the same
   visible error rather than silently defaulting on the runtime
   side.
4. **Existing per-agent `gateway_config.tracker` rows should stop
   being written.** When the cutover happens, the writers
   (`defaultAgentGatewayConfig`, `repairManagerGatewayConfig`,
   `buildGatewayConfig`, `repairGatewayConfig`) should stop seeding
   `tracker` into `config_json`. The runtime should ignore
   `config_json.tracker` if present and use
   `workspace_settings.tracker_kind` exclusively. Document this so a
   future reader doesn't see the field in old rows and assume it's
   load-bearing.

### Updated phased work

This adds two cleanup-phase items to the previously documented PRs:

- **PLATFORM-CUTOVER-1** — Once RUNTIME-2 + RUNTIME-3 are in
  production, remove the `tracker` defaults from
  `defaultAgentGatewayConfig` and `repairManagerGatewayConfig`. Stop
  writing `config_json.tracker` for new rows. Keep readers tolerant
  of the field still being present on legacy rows.
- **PLATFORM-CUTOVER-2** — Migrate existing rows: for each
  workspace, derive a tracker kind from the agents'
  `config_json.tracker.kind` values (preferring planning/coding
  agents on conflict), upsert `workspace_settings.tracker_kind`,
  then null out `config_json.tracker` for the workspace's agent
  rows. Run as a one-off script in `scripts/`, idempotent and
  re-runnable, with a `--dry-run` flag.

Both items gate on RUNTIME-2/3 being live in production so the
runtime can resolve tracker from `workspace_settings` for everything
in the workspace before the per-agent field is removed.

## Non-Goals

- Bulk migration of historical work items when a workspace switches
  tracker kinds. Switches apply only to new items.
- Custom UI for creating Linear/GitHub credentials (reuse the existing
  credential management flow).
- Showing the resolved tracker kind in every chat message. The settings
  panel and broker logs are sufficient.
- Per-agent tracker overrides. Tracker is workspace-scoped only.

## Open Questions

- Should the settings panel show a live "tested last at" status (we
  pinged the tracker successfully)? Default proposal: out of scope; can
  follow up with a dedicated tracker-health endpoint.
- Should switching kinds require explicit confirmation when there are
  in-flight work items? Default proposal: warn but allow; in-flight
  items finish on their current adapter.
- API endpoint shape: PATCH `.../settings/tracker` (narrow) vs PATCH
  `.../settings` (general). Default: narrow now, generalize when more
  settings need write paths.

## Companion PRs / Cross-Repo Pieces

- **parallel-agent-runtime**: Tracker behaviour refactor, per-workspace
  resolution, planner tool `workspace_settings.update_tracker_kind` —
  see runtime scope doc.
- **harper-server**: migration adds `workspace_settings.tracker_kind`
  and `workspace_settings.tracker_credential_id` — see harper-server
  scope doc.
