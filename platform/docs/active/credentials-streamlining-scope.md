# Credentials — Streamlining Scope

## Goal

Make credential creation and use boring. Today every credential flow is
slightly different — different UI, different validation timing, different
storage shape, different scope — and `credential.kind` can silently disagree
with `key_value.provider` because nothing enforces the relationship. A user
who wants to "connect OpenAI" should have exactly one path and the system
should never be able to land a row in an inconsistent state.

Specifically:

1. **One credential creation flow** in the UI. Provider chosen once, secret
   captured once (or OAuth flow once), credential saved once.
2. **One credential storage shape** — `key_value.provider` and
   `credential.kind` derived from a single source of truth, enforced by
   schema, not by helper functions.
3. **One validation gate.** Credentials are validated at save time, surface
   re-validation when they fail at use time, and OAuth refresh failures are
   first-class errors (not silently fall back to a stale token).
4. **Local-dev and production share the same flow.** No special-case dev
   credential bootstrapping; the same forms work in both environments,
   differing only in what's pre-populated.

## Current state

This section is grounded in a file audit. Each ref is repo-root relative.

### Ambiguity #1 — `kind` vs `key_value.provider` can drift

- `apps/api/src/repositories/credentials.ts:362` — `credentialKind()` derives
  the column from JSONB.
- `apps/api/src/services/saved-credentials.ts:66` —
  `detectCredentialProviderFromRecord()` re-derives provider from JSONB
  independently when listing credentials.
- `apps/api/src/services/credential-resolver.ts:218` — same detection
  happens a third time at resolve.

Nothing enforces that the three derivations agree, and there is no
migration that backfilled `kind` from `key_value` for legacy rows. A row
with `kind="openai"` and `key_value.provider="anthropic"` is currently
representable; no DB constraint catches it.

### Ambiguity #2 — four storage shapes, ad-hoc handling

- **Inline API key**: `{ provider, OPENAI_API_KEY, key_last4 }`
- **Inline OAuth (new)**: `{ provider: "openai_codex", access_token, refresh_token, expires_at, email, ... }`
- **`secret_ref`** (external secret manager): `{ provider, secret_ref }`
- **Agent-scoped** (`key_value.agent_id` overlay on any of the above)

Each shape is detected piecemeal in:

- `apps/api/src/services/saved-credentials.ts:62` (multi-row expansion)
- `apps/api/src/services/stored-credentials.ts:24` (oauth refresh)
- `apps/api/src/services/credential-resolver.ts:218` (provider detection)
- Runtime side: `apps/orchestrator/lib/symphony_elixir/agent_inventory/database.ex:235`

No single function answers "what shape is this row?" — each consumer
re-detects, sometimes differently.

### Ambiguity #3 — `key_value.agent_id` is JSONB, must be filtered in TS

- `apps/api/src/repositories/credentials.ts:69` — `readKeyValueAgentId()`
  parses agent_id out of the JSON column.
- `apps/api/src/repositories/credentials.ts:148` —
  `listAgentCredentialRows()` fetches every credential in the workspace and
  filters in memory. O(n) per agent lookup.

Per `docs/reference/oq-04-credentials-pr-plan.md`, this was an intentional
tradeoff — `credential.agent_id` was dropped to avoid a column with
production data. But the cost is hot-path inefficiency plus a footgun
(PostgREST arrow filters silently return wrong results; the file has a
prominent comment warning future authors off).

### Ambiguity #4 — three scopes coexist without UI distinction

| Scope     | DB encoding                          | Aliases? |
| --------- | ------------------------------------ | -------- |
| Workspace | `credential.workspace_id` set        | Yes      |
| User      | `credential.user_id`, no workspace   | No       |
| Agent     | `key_value.agent_id` (JSONB overlay) | No       |

The same `credential` table holds all three. A user has no clear UI to
understand or change the scope of a credential they just created. Routing
rules are workspace-scoped and can reference workspace credentials directly
or workspace aliases, but reaching an agent-scoped credential requires a
secondary lookup (`apps/api/src/services/execution-profile-resolver.ts:177`).

### Ambiguity #5 — three UIs create credentials, OAuth is planned separately

- `apps/web/src/components/dashboard/InlineCredentialForm.tsx` — onboarding
  (provider + model + key).
- `apps/web/src/components/settings/AgentCredentials.tsx` — settings page
  (provider + key, plus alias subflow).
- `apps/web/src/components/settings/CredentialPicker.tsx` — assignment
  (pick an existing credential as the routing-rule reference).
- `apps/web/src/components/OnboardingCards/CloudKeyCard.tsx` — wraps
  `InlineCredentialForm` for the onboarding wizard.

The picker shows the same providers in each. Validation rules differ. There
is no current in-repo ChatGPT/OAuth web component; OAuth is a planned
credential format that should be added through the same editor rather than a
parallel hardcoded UI.

### Ambiguity #6 — `CredentialKind` vs `CredentialProvider` enums maintained in three places

- `apps/api/src/repositories/credentials.ts:320` — `CREDENTIAL_KIND_VALUES`
  (16 entries, the DB constraint mirror).
- `contracts/provider-registry.ts:158` — `CREDENTIAL_PROVIDER_IDS`
  (11 entries, model-provider credentials only).
- `harper-server/supabase/migrations/20260425170000_oq04_credential_schema_overhaul.sql:127`
  — the SQL `credential_kind_check` constraint.

Three lists, no automated sync. PR #434 already shipped one bug where a new
model provider (`openai_codex`) was added to `MODEL_PROVIDER_IDS` without a
matching credential-kind/constraint path — caught only when the user hit a
502 from a DB constraint violation in production-shaped behavior.

### Ambiguity #7 — validation happens at different times, only for OpenAI

- `apps/api/src/provider-validation.ts:11` — `validateOpenAiCredential()`
  hits `/v1/models`.
- `apps/api/src/routes/models.ts:30` — runs on workspace credential save.
- `apps/api/src/routes/stored-agent-credentials.ts:397, 501` — runs on
  launch (codex worker activation), reports
  `skipped_validation_failed` if it fails.
- `apps/api/src/routes/stored-agent-credentials.ts:294` — agent-scoped
  inline save: **no validation**. Invalid keys land in the DB silently.
- `apps/api/src/services/stored-credentials.ts:48` — if OAuth refresh
  fails, returns the cached (stale) access token with a warning log. The
  worker discovers the failure when it can't talk to the API.

Anthropic, xai, google, etc. have no validation function at all.

### Ambiguity #8 — local-dev and production credentials use the same flow but the dev shortcut is undocumented

- `apps/web/src/components/Login.tsx:54` — dev login uses
  `VITE_DEV_LOGIN_EMAIL` / `VITE_DEV_LOGIN_PASSWORD`.
- CLAUDE.md mentions a **"Use dev credentials" button** in the login page;
  confirmed by file content. No equivalent for _model credentials_.
- `OPENAI_API_KEY` in `.env` is read by the API for its own internal use
  (e.g., manager scheduler), not surfaced as a workspace credential.

Today a local dev has to manually create a credential in the UI even when
the workspace `.env` already has `OPENAI_API_KEY=…` set. There's no
"bootstrap workspace credentials from .env" path.

## Proposed model

### Storage — collapse to one value type with a typed kind

```ts
// contracts/credentials.ts (canonical)
export type CredentialKey =
  | { format: "api_key"; provider: ModelProvider; secret: string }
  | {
      format: "oauth";
      provider: "openai_codex";
      access: string;
      refresh: string;
      expiresAt: number;
      identity?: OAuthIdentity;
    }
  | { format: "secret_ref"; provider: ModelProvider; secretRef: string }
  | {
      format: "compatible_endpoint";
      provider: "openai_compatible";
      baseUrl: string;
      secret: string | null;
    };

export type CredentialScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "user"; userId: string }
  | { kind: "agent"; workspaceId: string; agentId: string };
```

Today's four overlapping shapes become one discriminated union. The DB
column `kind` is derived from `format + provider` by exactly one helper.

### Schema — promote derived fields, drop the footgun

Single harper-server migration:

1. **Add `credential.format` column** (`api_key | oauth | secret_ref | compatible_endpoint`).
   Constrained, not-null. Backfilled from current `kind` + `key_value` shape.
2. **Add `credential.provider` column** (text, not-null, constrained to a
   union of `ModelProvider`). Backfilled from `key_value.provider`.
3. **Move `agent_id` back to a column** (`credential.agent_id`, nullable
   uuid, FK to `agent.id`). Indexed. Eliminates the OQ-04 TS-filter
   workaround. The original OQ-04 concern was preserving production data
   during the rename; backfill from `key_value.agent_id` and drop the
   JSONB field in the same migration is safe now.
4. **Drop `credential.kind`** — fully redundant with `(format, provider)`.
5. **Add a unique constraint** on `(workspace_id, agent_id, provider)`
   where `agent_id` is not null, and on `(workspace_id, provider)` where
   `agent_id` is null. Prevents duplicate credentials.
6. **`credential_alias`** stays workspace-scoped. Add an optional
   `agent_id` column to support agent-scoped aliases when needed.

After this migration, `key_value` JSONB holds only the secret material
(`secret`, `access`, `refresh`, `expiresAt`, `secretRef`, `baseUrl`,
`identity`) — every other field is a real column with a real constraint.

### One write path

Single endpoint:

```
POST /api/credentials
Body: {
  scope: CredentialScope;
  key: CredentialKey;
  alias?: string;          // optional, workspace-scoped
}
```

Replaces:

- `POST /api/stored-agents/:id/credentials` (agent-scoped inline)
- `POST /api/model-providers/:provider/credentials` (workspace-scoped)
- `POST /api/manager-agent/activate` (the credential portion)
- `POST /api/credentials/openai-codex/oauth/start` + `/poll` (this stays
  separate because it spans two requests — but the persist step calls the
  same handler internally)

Validation:

- Save is gated on a synchronous "does this credential work?" check per
  format (`api_key`: hit provider's /models, `oauth`: decode JWT and
  confirm expiry hasn't passed, `secret_ref`: confirm the ref resolves,
  `compatible_endpoint`: hit the baseUrl /models).
- Failure surfaces in the response, not silently in the DB.

### One credential picker

`apps/web/src/components/CredentialEditor.tsx` (new):

- Tabbed by **format**: API Key | ChatGPT (OAuth) | Secret Reference | OpenAI-Compatible Endpoint.
- The tab determines the rest of the form.
- One submit handler. One API call.

`AgentCredentials`, `InlineCredentialForm`, and the manager activation
flow embed this component instead of carrying their own form state.
`CredentialPicker` keeps its job (pick an existing credential) but its
"add new" button opens the same `CredentialEditor` in a modal.

### One scoping decision per save

Today the user doesn't think about scope; the API picks based on which
endpoint was called. After the refactor, the UI shows three radio
options:

- **For this agent only** (`scope.kind = "agent"`)
- **For this workspace** (`scope.kind = "workspace"`) — default
- **Personal** (`scope.kind = "user"`) — only shown when there's no
  workspace context

With visible explanation of what each means. Routing rules can reference
any scope via the existing `credential_id` / alias mechanism.

### Re-validation + revocation handling

- Every saved credential gets a `validation_state` field
  (`ok | invalid | expired | unknown`) and `validated_at`.
- A background job (or on-demand from the UI) re-checks credentials older
  than ~24h.
- When a worker fails to authenticate, the platform marks the credential
  `invalid` and surfaces a banner in the UI: _"Your OpenAI key was
  rejected. [Re-test] [Edit] [Replace]"_.
- For OAuth, refresh failure transitions to `expired` instead of silently
  returning a stale token. The connect-ChatGPT modal re-opens.

### Local-dev shortcut

Add a **"Use dev credentials"** affordance to the credential editor,
mirroring the existing dev-login button:

- Only renders when `import.meta.env.DEV` and the corresponding env vars
  are set (`VITE_DEV_OPENAI_API_KEY`, etc.).
- One click fills the secret field. Save still goes through the same
  endpoint + validation.
- Production builds strip the affordance entirely (it's a Vite-time
  conditional, not a runtime gate).

For **OAuth in local dev**, add a `VITE_DEV_OPENAI_CODEX_ACCESS_TOKEN`
escape hatch that lets developers paste a manually-acquired OAuth token
into the system without going through the device-code flow. Same dev-only
gating.

## Phased migration

Each phase is independently shippable.

### Phase 1 — Lock down the bug class we just hit (1 PR, this repo only)

- Define `CredentialKey` discriminated union in `contracts/credentials.ts`.
- Update `credentialKind()` to operate on `CredentialKey` rather than raw
  JSONB. Today's 8-test contract in `credentials.test.ts` becomes the
  reference for which shapes are valid.
- Add a runtime invariant test: round-trip every `CredentialKey` shape
  through save + read and confirm `kind`, `provider`, and `format`
  derivations match.

No DB change. No UI change. Purely tightens the type wall around the
existing flow.

### Phase 2 — Promote derived fields to columns (harper-server PR + this repo)

- harper-server migration: add `credential.format`, `credential.provider`,
  `credential.agent_id`, drop `credential.kind`, add unique constraints.
  Backfill from `key_value`.
- This repo: stop deriving these fields from JSONB; read them from the
  new columns. `listAgentCredentialRows()` becomes a one-query SELECT
  with `WHERE agent_id = ?`.
- Delete the OQ-04 TS-filter scaffolding.

### Phase 3 — One credential editor (this repo)

- Build `CredentialEditor` component.
- Inline into `AgentCredentials`, `InlineCredentialForm`,
  `ManagerAgentSection`, `CredentialPicker` (as the "add new" modal).
- Delete the three legacy components or reduce them to thin wrappers.

### Phase 4 — Unified API endpoint + scope picker (this repo)

- Add `POST /api/credentials` + new contract.
- Migrate the editor to call it.
- Deprecate the four legacy endpoints (still respond for one release
  cycle).

### Phase 5 — Validation + revocation (this repo + runtime)

- Add `validation_state` + `validated_at` columns (harper-server migration).
- Validation function per format. Save calls it; UI surfaces the result.
- Background cron: re-validate stale credentials.
- Runtime: when a worker auth call fails, report back to the platform via
  the launcher; platform marks the credential invalid.

### Phase 6 — Local-dev shortcut + delete legacy routes (this repo)

- `CredentialEditor` gets the dev-credentials button.
- Legacy POST endpoints removed.

## Local vs production: what changes

| Concern              | Local dev (today)                        | Production (today) | After refactor                                             |
| -------------------- | ---------------------------------------- | ------------------ | ---------------------------------------------------------- |
| Acquiring an API key | User pastes from terminal                | User enters in UI  | Same UI; "Use dev credentials" autofills when env vars set |
| OAuth (ChatGPT)      | Same as prod                             | Device-code flow   | Same; `VITE_DEV_OPENAI_CODEX_ACCESS_TOKEN` escape in dev   |
| Secret manager       | Not used                                 | `secret_ref` rows  | Same                                                       |
| Validation           | Maybe runs at save, definitely at launch | Same               | Always at save; surfaced revocation                        |
| Storage              | Same JSONB shape                         | Same JSONB shape   | `kind`/`provider`/`format`/`agent_id` are columns          |

The principle: production and local use the same flows. Local just has
optional pre-population and an OAuth bypass for headless testing.

## Open questions

- **Multi-user credential sharing.** Today a workspace credential is
  visible to all workspace members. Is there a future need for "I want
  to share my OpenAI key with the workspace but not let others read it
  back" (i.e., write-once, never-decrypt-to-UI)? If yes, the `key_value`
  JSONB should be opaque at rest with separate `secret_ref` resolution.
- **Multi-credential agents.** Latent ask: same agent uses different
  credentials per intent (codegen uses OpenAI, review uses Anthropic).
  Today's `credential_id` on the routing rule is singular. If we go
  multi-credential, `CredentialKey` doesn't change but the routing rule
  schema does.
- **Provider-specific identity.** OAuth credentials carry email + plan
  type today. API keys don't carry any identity. Should we add an
  optional `display_name` column for user-set labels (e.g., "team account"
  vs "personal")?
- **Sunset path for `agent.model_settings.primary`.** That field still
  feeds the fallback model resolution. The unified-execution-profile
  scope doc proposes deleting it; this doc assumes that's done.
- **Provider validation API surface.** The proposal calls for one
  validator per format. For non-OpenAI providers, this either requires
  a hit to that provider's API (costs money, adds latency, may be rate
  limited) or a heuristic (key prefix shape). Need to pick.

## Out of scope

- The execution profile / routing-rule consolidation. See the companion
  doc `docs/active/unified-execution-profile-scope.md`. The two are
  related but independently shippable.
- Encryption at rest. Today `key_value` is plaintext in the DB. If we
  move to encrypted-at-rest, that's a separate harper-server-led
  initiative.
- Tool grants. Separate refactor (`agent-tool-grant-data-model-scope.md`).

## Success criteria

- A new credential provider can be added with edits in exactly two
  places: the `CredentialKey` discriminated union and the harper-server
  provider constraint.
- A row in the `credential` table cannot land in an inconsistent state.
  `kind`, `provider`, and `key_value.provider` cannot disagree because
  `kind` no longer exists and `provider` is a constrained column derived
  before the JSONB is written.
- The user sees exactly one form to create a credential, with the format
  choice (API key / OAuth / secret ref / endpoint) on one tab strip.
- Local dev and production share the same flow; the only difference is
  whether the dev-credentials button is rendered.
- Validation failures (revoked key, expired OAuth) are reported back to
  the user in the UI within one minute of the next agent activation
  failure.
