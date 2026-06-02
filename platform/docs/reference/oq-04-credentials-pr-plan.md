# OQ-04 Credentials — Implementation PR Plan

Implementation scope for [OQ-04: Per-task model overrides — credentials](./open-questions/oq-04-per-task-model-overrides-credentials.md).

The decision was settled in OQ-04 itself (routing rules pass `credential_id`; agent reads from DB at dispatch). This doc breaks the unbuilt functionality into eight reviewable PRs across `harper-server`, `parallel-agent-platform`, and `parallel-agent-runtime`.

Companion to:

- [`oq-01-plan-format-pr-plan.md`](./oq-01-plan-format-pr-plan.md) — same shape
- [`oq-02-local-runtime-connector-pr-plan.md`](./oq-02-local-runtime-connector-pr-plan.md)
- The manager-agent PR plan in `parallel-agent-runtime/apps/orchestrator/docs/manager-agent-pr-plan.md`

## What was decided (recap)

- Routing rules reference `credential_id` (or a workspace-scoped alias that resolves to one). Never raw API keys; never anything in `work_item.labels`.
- Envelope encryption at rest. Plaintext only exists in orchestrator memory at dispatch time.
- Per-workspace alias mapping (`credential_alias` table) so rotating a credential is a one-row update, not "edit every routing rule that references it."
- Audit log of every resolve.

## Current state — what exists today

Audit against `harper-server/main`, `parallel-agent-platform/main`, `parallel-agent-runtime/main` at scope-doc time.

### Database (`harper-server`)

The `credential` table exists but is **substantially under-built** vs the OQ-04 design:

| Concern                                                              | Today                                                                                                                                    | OQ-04 requires                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Schema (`20260119120000_create_credential_table.sql`)                | `id uuid pk, key_value jsonb, agent_id uuid fk, user_id uuid fk`                                                                         | + `workspace_id uuid fk`, `kind`, `display_name`, encrypted secret column |
| `workspace_id` (`20260302061000_add_workspace_id_to_credential.sql`) | `text not null default 'main'` (legacy convention)                                                                                       | `uuid not null references public.workspaces(id)`                          |
| Encryption                                                           | **None.** `key_value` stores plaintext jsonb.                                                                                            | Envelope-encrypted with KMS data key per workspace                        |
| RLS                                                                  | `USING (true)` for all four CRUD operations on `authenticated` — **any authenticated user can read every credential in every workspace** | Workspace-member-scoped, like the recent migrations                       |
| `credential_alias` table                                             | **Does not exist**                                                                                                                       | New table mapping `(workspace_id, alias)` → `credential_id`               |
| Audit log of resolves                                                | **Does not exist**                                                                                                                       | New `credential_resolution` table                                         |

`pgsodium` and `supabase_vault` Postgres extensions are already installed (`20250428142031_remote_schema.sql:15,54`) — encryption primitives are available, just not wired up to this table.

### Platform (`parallel-agent-platform`)

There's actually more existing credential infrastructure than I'd
initially captured. Worth being precise so PR 4 / PR 5 extend it
rather than duplicating:

**Already shipped — workspace-scoped per-(provider) credentials:**

- `apps/api/src/routes/models.ts:30` — `GET /api/model-providers?workspaceId=…` lists provider connections with `{ valid, credentialConfigured, lastError, modelCount }` per provider.
- `apps/api/src/routes/models.ts:49` — `POST /api/model-providers/:provider/credentials` accepts `{ workspaceId, apiKey, endpoint?, apiVersion? }`, **validates the key against the upstream provider** via `validateModelProviderCredential`, then calls `saveModelProviderCredentialForWorkspaceInSupabase`. Returns the updated provider state.
- `contracts/credentials.ts` — `CredentialProviderSchema = z.enum([openai, anthropic, xai, google, mistral, groq, openrouter, together, perplexity, azure])` and `CREDENTIAL_PROVIDER_REGISTRY` mapping each provider to env-var aliases and launchable kinds.
- `apps/web/src/components/settings/ModelsSection.tsx` — settings surface with "Connect provider" / "Update key" / per-provider validity badges.

**Missing (which is what OQ-04 adds):**

- No encryption — `saveModelProviderCredentialForWorkspaceInSupabase` writes `key_value` jsonb in plaintext.
- No `Credentials.resolve(alias_or_id, workspace_id)` service. Other consumers (setup.ts, default-agent-credentials.ts) read `key_value` directly via the credentials repo.
- No `credential_alias` table or alias-based resolution.
- No user-only credentials — the existing route is workspace-only via the `workspaceId` body parameter.
- No `/api/credentials` general CRUD path; only the per-provider-named endpoint.
- No `POST /api/credentials/:id/test` as a re-runnable health check (validation happens once at save).
- No `credential_resolution` audit log.

**Other touchpoints worth tracking** (to avoid breaking on migration):

- `apps/api/src/repositories/credentials.ts` — the data-access layer (`listAgentCredentialRows`, `listWorkspaceModelProviderCredentialRows`, `updateCredentialKeyValue`, `createAgentCredential`). Reads `key_value` jsonb directly.
- `apps/api/src/services/setup.ts` and `apps/api/src/services/default-agent-credentials.ts` — both read credentials inline; both must migrate to `Credentials.resolve` in PR 3.

### Runtime (`parallel-agent-runtime`)

- Runners read credentials **out of config maps**, not via a credential-resolve API. E.g. `runner/openclaw.ex`:
  ```elixir
  api_key = Map.get(config, "api_key")
  ```
  The `config` is built upstream and `api_key` is the literal string, not a `credential_id`.
- No Elixir module wraps the credential-resolution path.
- No outbound prompt redaction pass.
- No lint rule preventing secrets from landing in `work_item.labels` or other audit-bound columns.

### What this means in practice

A credential's plaintext API key is currently:

1. Stored in plaintext in the DB.
2. Readable by every authenticated user in every workspace via RLS.
3. Passed around the runtime as a string in config maps.
4. Not redacted from outbound prompts.
5. Not audited when used.

OQ-04 is about closing all five of those gaps.

## Cardinality: per-(workspace, kind) or per-(user, kind), not per-agent

Today's `credential` table has an `agent_id` FK column. Each row is tied to a specific agent. **That's wrong.** Two OpenAI agents in the same workspace force two credential rows and two separate API-key entries, even when the user wants the same key for both.

The right model is **credentials are scoped to (workspace, kind) when shared, or to (user, kind) when personal** — multiple agents share one row. The user enters their OpenAI key once; any OpenAI-using agent reads it.

### Workspace association is optional

A credential's `workspace_id` is **nullable**:

- **Workspace-scoped credential** (`workspace_id` set) — visible / usable by any member of that workspace. Use case: a team's shared OpenAI key.
- **User-only credential** (`workspace_id IS NULL`) — visible / usable only by the owning user (`credential.user_id`), in any workspace they're a member of. Use case: a user's personal OpenAI key that they want to use across multiple workspaces without re-entering.

The owning `user_id` is always populated (not nullable; the user who created the credential always owns it).

A user with one personal OpenAI key working across two workspaces enters their key **once**.

### Schema implications

- `credential.workspace_id` is `uuid` nullable, no default. Migration drops the legacy `text not null default 'main'` column entirely; we have no production users so no backfill is needed.
- `credential.agent_id` is **dropped entirely** (no production data to preserve). Same migration as the workspace_id reshape — bundle, don't sequence.
- `credential.user_id` is `not null` (already is); it's the owning user.
- Two partial unique indexes (since standard UNIQUE treats NULLs as not-equal, which would let a user accidentally create two identical user-only credentials):

  ```sql
  -- workspace-scoped: unique within a workspace
  create unique index uq_credential_workspace_kind_name
    on public.credential (workspace_id, kind, display_name)
    where workspace_id is not null;

  -- user-only: unique per user across the null-workspace namespace
  create unique index uq_credential_user_kind_name_user_only
    on public.credential (user_id, kind, display_name)
    where workspace_id is null;
  ```

- `credential_alias` (the table in PR 1) provides workspace-scoped names like `default-openai`, `default-anthropic`, `personal-llama`. Aliases live in a workspace's namespace but can point at either a workspace-scoped or user-only credential (the alias-target dependency is just a credential FK; whether the credential happens to have a workspace_id is irrelevant to the alias).

### Resolution: three-tier lookup with workspace-precedence

`Credentials.resolve` accepts three input forms, tries in order:

1. **Explicit `credential_id`** → look up directly. Allowed if EITHER (a) the credential's `workspace_id` equals the dispatch `workspace_id`, OR (b) `credential.workspace_id IS NULL` AND `credential.user_id` matches the user dispatching the work.
2. **Explicit alias** (`default-openai`, etc.) → resolve via `credential_alias (workspace_id, alias) → credential_id`. The dispatching user must have access to the resolved credential per (1)'s rules.
3. **`kind` only** → composite resolution:
   - First, look for a workspace-scoped credential matching `(workspace_id, kind)` — if there's a `default-<kind>` alias, use it; else if there's exactly one workspace-scoped credential of that kind, use it.
   - If no workspace-scoped match, fall through to a user-only credential matching `(user_id, kind)` — if there's exactly one, use it.
   - If neither, fail with `:no_default_credential_for_kind`. The dashboard surfaces this as "your OpenAI agents don't have a credential — pick or create one."

**Workspace-scoped wins over user-only.** A workspace setting overrides a user's personal default; users can be explicit via aliases when they want their personal key to win.

### Front-end UX implication

When the user adds an agent that needs an API key, the dashboard:

- Queries `GET /api/credentials?workspace_id=…&kind=<kind>` (returns workspace-scoped credentials for the workspace AND the user's user-only credentials of that kind).
- If existing credentials of that kind exist:
  - Shows **"Use existing key '<display_name>' or add a new one"** dropdown. Each option labels itself as "workspace" or "personal" so the user knows what they're picking.
- If none exist:
  - Prompts for a new plaintext key + display_name.
  - Offers two toggles:
    - "Share this with the workspace" (default off — user-only credential)
    - "Make this the default for `<kind>` agents in this workspace" (default on if creating a workspace-scoped credential, default off for user-only)

After this lands, a user with three OpenAI agents enters their API key exactly once.

### Existing-row deduplication: explicitly NOT in scope

No production users yet — we're in pre-launch — so the migration just changes the schema and nothing about existing data. The new uniqueness constraints apply going forward; if any pre-existing rows violate them at apply time, the migration will fail loudly and the conflict can be resolved by hand. We do not write logic to silently dedup.

## Target state — what we're building

| Layer     | Today                                         | After this work                                                                               |
| --------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Storage   | Plaintext jsonb                               | Envelope-encrypted bytea                                                                      |
| Discovery | Direct table reads with no FK / RLS scoping   | `Credentials.resolve(alias_or_id, workspace_id)` API on both sides                            |
| Naming    | None — raw UUIDs                              | Workspace-scoped aliases (`default-anthropic`, `personal-llama`) via `credential_alias` table |
| Schema    | One column for everything (`key_value` jsonb) | `kind` enum + structured columns                                                              |
| RLS       | Wide open                                     | Workspace-member-scoped                                                                       |
| Audit     | None                                          | `credential_resolution` table per resolve                                                     |
| Defenses  | None                                          | Outbound-prompt redaction pass + lint rules banning secret strings in audit-bound columns     |

## PR plan

Eight PRs across three repos. Three sequencing tracks; some can run in parallel.

```
PR 1 (harper: schema hardening) ──► PR 2 (harper: encryption)
                                          │
                                          ├──► PR 3 (platform: Credentials.resolve service)
                                          │           │
                                          │           ├──► PR 4 (platform: Credential CRUD API)
                                          │           │           │
                                          │           │           └──► PR 5 (platform/web: management UI)
                                          │           │
                                          │           └──► PR 6 (runtime: Credentials.resolve + redaction + lints)
                                          │
                                          └──► PR 7 (harper: credential_resolution audit table)
                                                            │
                                                            └──► PR 8 (platform+runtime: write to audit log on resolve)
```

PR 5 (web UI) and PR 6 (runtime) can run in parallel after PR 3.
PR 7 + PR 8 (audit log) can run in parallel with PR 4–6 once PR 2 is in.

## Parallelization map

For fanning the work out across multiple implementers / Codex sessions:

| Phase                               | What's unlocked                           | Run in parallel                                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** (now)                         | Nothing yet                               | PR 1 ([harper-server#488](https://github.com/harper-hq/harper-server/pull/488)) is in flight; merge first.                                                                                                    |
| **1** (after PR 1 merges)           | Schema is in place                        | **PR 2** (encryption migration in `harper-server`) and **PR 7** (audit-table migration in `harper-server`) — both are pure migrations, no code dependencies, can ship simultaneously.                         |
| **2** (after PR 2 merges)           | Encryption helpers exist                  | **PR 3** (platform `Credentials.resolve` service) and **PR 6** (runtime `Credentials` module + lints + redaction) — both consume the same DB helpers but live in different repos and can ship simultaneously. |
| **3** (after PR 3 merges)           | Platform resolve service exists           | **PR 4** (CRUD API endpoints) — single PR, no parallel siblings (PR 6 is already running from phase 2).                                                                                                       |
| **4** (after PR 4 merges)           | API surface exists                        | **PR 5** (web UI) — single PR.                                                                                                                                                                                |
| **5** (after PRs 3, 6, 7 all merge) | Both resolve services + audit table exist | **PR 8** (audit-write integration) — split into two coordinated PRs (one per repo); they can ship in either order.                                                                                            |

In practice that means an implementer can be working on PR 2 + PR 7 simultaneously after PR 1 lands; then PR 3 + PR 6 simultaneously; then PR 4 by itself; then PR 5 + PR 8 (platform half) + PR 8 (runtime half) all in parallel. Five PRs of concurrent work at peak.

### PR 1 — `harper-server` migration: schema hardening

**Repo:** `harper-server`
**Branch:** `migrations/credential-schema-hardening`
**Depends on:** none.

**Scope:**

**No backfill, no dedup, no preserved-data acrobatics.** No production users yet, so this migration just rewrites the schema. If pre-existing rows happen to violate a new constraint at apply time, the migration fails loudly and we resolve by hand.

```sql
-- 1. Drop the legacy text workspace_id and the per-agent FK; the
--    new schema treats workspace as optional and credentials as
--    shareable across agents.
alter table public.credential drop column workspace_id;
alter table public.credential drop column agent_id;
-- (drop the agent_id_fk constraint if not auto-removed by drop column)

-- 2. Add the new workspace_id (uuid, nullable, no default).
--    NULL means "user-only credential — usable by the owning user
--    in any workspace they're a member of."
alter table public.credential
  add column workspace_id uuid
    references public.workspaces(id) on delete cascade;

-- 3. Add kind, display_name (both NOT NULL — every new credential
--    must declare both).
--
-- The kind enum is the union of:
--   (a) the existing CredentialProviderSchema values from
--       contracts/credentials.ts (so existing
--       /api/model-providers/:provider/credentials routes write
--       kind = <provider> directly), AND
--   (b) non-model-provider credential kinds for OAuth, AWS, etc.
--
-- Keeping the values matched to CredentialProviderSchema where
-- possible avoids a translation layer and lets the existing UI
-- (ModelsSection.tsx) work unchanged.
alter table public.credential
  add column kind text not null
    check (kind in (
      -- model providers (mirrors contracts/credentials.ts CredentialProviderSchema)
      'openai', 'anthropic', 'xai', 'google', 'mistral',
      'groq', 'openrouter', 'together', 'perplexity', 'azure',
      -- non-model-provider kinds
      'openai_compatible_endpoint',     -- OpenAI-format API at a non-OpenAI URL
      'oauth_subscription',              -- per OQ-11
      'oauth_refresh_token',             -- generic OAuth flow
      'github_app_install',              -- GitHub App installation token
      'aws_credentials',                 -- AWS access key / secret pair
      'other'                            -- escape hatch
    )),
  add column display_name text not null;

-- 4. Two partial unique indexes — UNIQUE treats NULL as not-equal,
--    which would let a user create two identical user-only
--    credentials. Partial indexes split workspace-scoped from
--    user-only.
create unique index uq_credential_workspace_kind_name
  on public.credential (workspace_id, kind, display_name)
  where workspace_id is not null;

create unique index uq_credential_user_kind_name_user_only
  on public.credential (user_id, kind, display_name)
  where workspace_id is null;
```

- Tighten RLS — drop the four `USING (true)` policies and replace with policies that handle both workspace-scoped and user-only rows:

  ```sql
  drop policy if exists authenticated_read_credential on public.credential;
  drop policy if exists authenticated_insert_credential on public.credential;
  drop policy if exists authenticated_update_credential on public.credential;
  drop policy if exists authenticated_delete_credential on public.credential;

  -- SELECT: a workspace member may see workspace-scoped credentials
  -- in their workspace; a user always sees their own user-only
  -- credentials regardless of workspace.
  create policy credential_select on public.credential
  for select to authenticated
  using (
    (
      workspace_id is not null
      and exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = credential.workspace_id
          and wm.user_id = public.current_app_user_id()
      )
    )
    or (
      workspace_id is null
      and credential.user_id = public.current_app_user_id()
    )
  );

  -- INSERT: user_id MUST equal the inserting user; workspace_id
  -- (when set) MUST be a workspace the user is a member of.
  create policy credential_insert on public.credential
  for insert to authenticated
  with check (
    credential.user_id = public.current_app_user_id()
    and (
      workspace_id is null
      or exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = credential.workspace_id
          and wm.user_id = public.current_app_user_id()
      )
    )
  );

  -- UPDATE / DELETE: same gates as SELECT (must be visible to act on).
  create policy credential_update on public.credential
  for update to authenticated
  using (...same as SELECT...) with check (...same as SELECT...);

  create policy credential_delete on public.credential
  for delete to authenticated
  using (...same as SELECT...);
  ```

- Create `public.credential_alias` table. **`workspace_id` is nullable**, mirroring the credential table — aliases can be either workspace-scoped (a workspace policy) or user-scoped (a personal preference that follows the user across workspaces). Exactly one of `workspace_id` / `user_id` is set per row:

  ```sql
  create table public.credential_alias (
    id            uuid primary key default gen_random_uuid(),
    workspace_id  uuid references public.workspaces(id) on delete cascade,
    user_id       uuid references public."user"(id) on delete cascade,
    alias         text not null check (alias ~ '^[a-z0-9-]+$' and length(alias) <= 64),
    credential_id uuid not null references public.credential(id) on delete restrict,
    created_at    timestamptz not null default now(),
    constraint credential_alias_one_scope check (
      (workspace_id is not null and user_id is null)
      or (workspace_id is null and user_id is not null)
    )
  );

  create unique index uq_credential_alias_workspace
    on public.credential_alias (workspace_id, alias)
    where workspace_id is not null;

  create unique index uq_credential_alias_user
    on public.credential_alias (user_id, alias)
    where workspace_id is null;
  ```

  Two partial unique indexes (rather than one composite) because UNIQUE treats NULL as not-equal. RLS: workspace member can SELECT workspace-scoped aliases; the owning user can SELECT user-scoped aliases. The alias-target FK is intentionally `on delete restrict` so a user can't accidentally delete a credential while aliases still point at it.

  Resolution semantics with both scopes: when the manager / dispatcher resolves `default-openai` for user U dispatching in workspace W, it checks **workspace W's `default-openai` first** (workspace-precedence rule); if absent, falls back to user U's `default-openai`; if still absent, fails.

**Out of scope:** the encryption work itself — this PR is just the schema. PR 2 wires up encryption.

**Testing:**

- Migration applies cleanly. No data preservation expectations.
- After apply, a workspace-A member cannot SELECT a workspace-B credential.
- A user CAN SELECT their own user-only credentials regardless of which workspace they're acting in.
- `kind` CHECK rejects unknown values.
- Alias regex rejects `Foo`, `foo bar`, alias longer than 64 chars; accepts `default-anthropic`.
- Cross-workspace alias collision is allowed (each workspace has its own namespace).
- Two user-only credentials with same (user_id, kind, display_name) is rejected by the partial unique index; a workspace-scoped + user-only with same kind+display_name is allowed (different scopes).

### PR 2 — `harper-server` migration: envelope encryption

**Repo:** `harper-server`
**Branch:** `migrations/credential-envelope-encryption`
**Depends on:** PR 1.
**Encryption mechanism (resolved):** `pgsodium` with per-(scope_kind, scope_id) keys. `scope_kind` is `'workspace'` for workspace-scoped credentials, `'user'` for user-only. Both are isolation boundaries in the new schema.

**Files to create:**

- `supabase/migrations/<ts>_oq04_credential_envelope_encryption.sql`

**Schema:**

```sql
-- New columns on public.credential
alter table public.credential
  add column secret_encrypted bytea,
  add column key_id           uuid;

comment on column public.credential.secret_encrypted is
  'pgsodium-encrypted plaintext (jsonb→text→bytea→encrypt). Decrypt only via public.decrypt_credential(); never expose to API responses.';
comment on column public.credential.key_id is
  'pgsodium key id this row was encrypted with. Resolves the per-(scope_kind, scope_id) key.';

-- key_value column is left in place but no longer written. Drop in a
-- follow-up after the platform code has migrated off it.
comment on column public.credential.key_value is
  'DEPRECATED. New writes go to secret_encrypted via public.encrypt_credential(). Slated for drop after platform migration completes.';
```

**Helper functions** (SECURITY DEFINER, owned by service role; verify exact pgsodium AEAD function names against the installed pgsodium version — `crypto_aead_det_encrypt` is the v3+ shape but earlier versions use `crypto_aead_aes256gcm_*`):

```sql
-- 1. Resolve or lazily create the encryption key for a credential's scope.
create or replace function public.credential_scope_key_id(
  p_workspace_id uuid,
  p_user_id      uuid
) returns uuid
language plpgsql security definer set search_path = pgsodium, public
as $$
declare
  v_key_name text;
  v_key_id   uuid;
begin
  if p_workspace_id is not null then
    v_key_name := 'credential-workspace-' || p_workspace_id::text;
  elsif p_user_id is not null then
    v_key_name := 'credential-user-'      || p_user_id::text;
  else
    raise exception 'credential_scope_key_id: both workspace_id and user_id are NULL';
  end if;

  select id into v_key_id from pgsodium.valid_key where name = v_key_name limit 1;
  if v_key_id is null then
    select id into v_key_id from pgsodium.create_key(name := v_key_name);
  end if;
  return v_key_id;
end;
$$;

-- 2. Encrypt: returns the ciphertext + the key_id used.
-- AAD binds the encryption to the credential's scope so a row can't be
-- decrypted with a different scope's key.
create or replace function public.encrypt_credential(
  p_plaintext    jsonb,
  p_workspace_id uuid,
  p_user_id      uuid
) returns table (secret_encrypted bytea, key_id uuid)
language plpgsql security definer set search_path = pgsodium, public
as $$
declare
  v_key_id uuid := public.credential_scope_key_id(p_workspace_id, p_user_id);
  v_aad    bytea := coalesce(p_workspace_id::text, p_user_id::text)::bytea;
  v_cipher bytea;
begin
  v_cipher := pgsodium.crypto_aead_det_encrypt(
    p_plaintext::text::bytea, v_aad, v_key_id
  );
  return query select v_cipher, v_key_id;
end;
$$;

-- 3. Decrypt: takes the ciphertext + key_id + scope. AAD verifies the scope.
create or replace function public.decrypt_credential(
  p_secret_encrypted bytea,
  p_key_id           uuid,
  p_workspace_id     uuid,
  p_user_id          uuid
) returns jsonb
language plpgsql security definer set search_path = pgsodium, public
as $$
declare
  v_aad        bytea := coalesce(p_workspace_id::text, p_user_id::text)::bytea;
  v_plaintext  bytea;
begin
  v_plaintext := pgsodium.crypto_aead_det_decrypt(
    p_secret_encrypted, v_aad, p_key_id
  );
  return v_plaintext::text::jsonb;
end;
$$;
```

**Permissions:**

```sql
revoke all on function public.encrypt_credential   from public;
revoke all on function public.decrypt_credential   from public;
revoke all on function public.credential_scope_key_id from public;
grant execute on function public.encrypt_credential   to service_role;
grant execute on function public.decrypt_credential   to service_role;
grant execute on function public.credential_scope_key_id to service_role;
-- Authenticated role NEVER calls these directly. Platform / runtime
-- service-role connections are the only callers.
```

**Migration of existing data:** none. PR 1 is a fresh schema with no rows.

**Acceptance criteria:**

- [ ] Migration applies cleanly. `pgsodium` AEAD function names verified against installed extension version.
- [ ] Round-trip: `encrypt_credential(jsonb_build_object('api_key', 'sk-…'), <workspace_id>, NULL)` then `decrypt_credential(…)` returns the original jsonb.
- [ ] AAD enforcement: decrypt with a different `workspace_id` than was encrypted with raises an error.
- [ ] Authenticated role gets `permission denied` when calling any of the three functions directly.
- [ ] Helpers are idempotent: calling `credential_scope_key_id` twice for the same `(workspace_id, NULL)` returns the same key id.

### PR 3 — `parallel-agent-platform`: `Credentials.resolve` service

**Repo:** `parallel-agent-platform`
**Branch:** `feat/credentials-resolve-service`
**Depends on:** PR 2 (encryption helpers in DB).

**Files to create / modify:**

- **Create** `apps/api/src/services/credentials.ts` (the resolve service)
- **Modify** `apps/api/src/repositories/credentials.ts` — switch reads from `key_value` to encrypted columns; mark direct `key_value` reads deprecated
- **Modify** `apps/api/src/services/setup.ts` — replace inline credential reads with `Credentials.resolve` calls
- **Modify** `apps/api/src/services/default-agent-credentials.ts` — same migration
- **Modify** `contracts/credentials.ts` (new file or extend existing) — typed shapes for the resolve API and the redaction guarantees

**Code sketch:**

```ts
// apps/api/src/services/credentials.ts
import * as util from "node:util";

export type ResolveInput =
  | { credentialId: string }
  | { alias: string; workspaceId: string }
  | { kind: string; workspaceId: string; userId: string };

export class ResolvedCredential {
  constructor(
    public readonly id: string,
    public readonly kind: string,
    public readonly displayName: string,
    public readonly workspaceId: string | null,
    public readonly userId: string,
    private readonly _plaintext: string,
  ) {}

  // Plaintext access is intentional and explicit. Callers must use this
  // method, never console.log or stringify the credential.
  get plaintext(): string { return this._plaintext; }

  toString(): string {
    return `<ResolvedCredential id=${this.id} kind=${this.kind} REDACTED>`;
  }
  toJSON(): unknown {
    return { id: this.id, kind: this.kind, redacted: true };
  }
  [util.inspect.custom](): string { return this.toString(); }
}

export class NoDefaultCredentialError extends Error {
  constructor(public kind: string, public workspaceId: string) {
    super(`No default credential of kind '${kind}' for workspace ${workspaceId}`);
    this.name = "NoDefaultCredentialError";
  }
}

export class CrossWorkspaceCredentialError extends Error { … }
export class CredentialNotFoundError      extends Error { … }

export async function resolve(
  input: ResolveInput,
  ctx: { actingUserId: string },
): Promise<ResolvedCredential> {
  // 1. By credentialId (UUID) — explicit lookup
  if ("credentialId" in input) {
    return resolveById(input.credentialId, ctx.actingUserId);
  }

  // 2. By alias — resolve via credential_alias, with workspace-precedence
  //    over user-scoped aliases of the same name
  if ("alias" in input) {
    return resolveByAlias(input.alias, input.workspaceId, ctx.actingUserId);
  }

  // 3. By kind — workspace's default-<kind> alias first, fall back to
  //    user's user-only credential of that kind. See "Cardinality" §
  //    above for the exact precedence.
  return resolveByKind(input.kind, input.workspaceId, ctx.actingUserId);
}
```

**SQL access pattern** (called from each `resolveBy*` helper):

```sql
-- Load + decrypt in one round-trip:
select
  c.id, c.kind, c.display_name, c.workspace_id, c.user_id,
  public.decrypt_credential(c.secret_encrypted, c.key_id, c.workspace_id, c.user_id) as plaintext
from public.credential c
where c.id = $1
  and (
    (c.workspace_id is not null and exists (
      select 1 from workspace_members wm
      where wm.workspace_id = c.workspace_id and wm.user_id = $2
    ))
    or (c.workspace_id is null and c.user_id = $2)
  );
```

**API response shape rule:** `secret_encrypted`, `key_id`, and any plaintext must be **stripped from every API response** — even error envelopes. The `ResolvedCredential` class' `toJSON` enforces this; reviewers should grep for `JSON.stringify(credential)` patterns.

**Caching:** none in v1. The service-role connection is fast enough; we'll add caching only if profiling shows a hot spot. Especially important to skip caching during the security audit window so a leaked plaintext can't outlive its credential row.

**Acceptance criteria:**

- [ ] `resolve({ credentialId })` works for both workspace-scoped and user-only credentials with correct membership/ownership gates.
- [ ] `resolve({ alias, workspaceId })` follows workspace-precedence: workspace-scoped alias wins over user-scoped same-named alias.
- [ ] `resolve({ kind, workspaceId, userId })` returns workspace's `default-<kind>` if set, else user's single user-only credential of that kind, else throws `NoDefaultCredentialError`.
- [ ] `console.log(credential)`, `String(credential)`, `JSON.stringify(credential)` all render redacted form. **Adversarial test:** wrap `resolve` output in `Error(JSON.stringify({ credential }))`; assert the plaintext does not appear in `error.message`.
- [ ] Cross-workspace by-id resolution throws `CrossWorkspaceCredentialError`.
- [ ] All callers of `apps/api/src/repositories/credentials.ts.updateCredentialKeyValue` are migrated; the old function is marked `@deprecated` with a JSDoc pointer to `Credentials.resolve`.

### PR 4 — `parallel-agent-platform`: Credential CRUD API

**Repo:** `parallel-agent-platform`
**Branch:** `feat/credentials-api`
**Depends on:** PR 3.

**Important — extend, don't duplicate.** The repo already has:

- `POST /api/model-providers/:provider/credentials` (`apps/api/src/routes/models.ts:49`) — saves a workspace-scoped per-provider credential, validates with upstream first.
- `GET /api/model-providers?workspaceId=…` (same file, line 30) — lists provider connections.
- `validateModelProviderCredential` in `apps/api/src/services/...` — the per-provider upstream-ping function. We **reuse** this for the new test endpoint.
- `saveModelProviderCredentialForWorkspaceInSupabase` — the existing write path. Migrated in PR 3 to write encrypted columns.

The existing routes keep working. PR 4 adds the new surfaces that don't fit the current per-provider shape: user-only credentials, aliases, the standalone test endpoint, and a generalized list/delete API.

**Files to create / modify:**

- **Modify** `apps/api/src/routes/models.ts` — add an optional `set_as_default?: boolean` to `SaveModelProviderCredentialRequestSchema`. When true and the new credential is workspace-scoped, the route ALSO upserts the `default-<provider>` alias in the same transaction. (Single-line addition to the request body schema + a small alias write inside the existing handler.)
- **Create** `apps/api/src/routes/credentials.ts` — the **generalized** API for the cases the existing route can't express: user-only credentials, the test endpoint, soft-delete, rotate, and a `kind`-filterable list.
- **Create** `apps/api/src/routes/credential-aliases.ts` — entirely new (no existing alias surface).
- **Create** `apps/api/src/services/credential-tester.ts` — per-`kind` upstream pings. Reuses `validateModelProviderCredential` for the model-provider kinds; adds new tester functions for `github_app_install` / `oauth_*` / `aws_credentials`.
- **Modify** `apps/api/src/app.ts` — register the two new route modules.
- **Modify** `contracts/credentials.ts` — extend with the new request / response shapes. **Reuse `CredentialProviderSchema`** as the kind enum's model-provider half rather than duplicating provider names.

**Endpoints:**

| Method   | Path                                         | Status                                                           | Body                                                                                                                                                                         | Response                                                                                                                                                                                                                                                                                                       |
| -------- | -------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/model-providers/:provider/credentials` | **Existing — extended** with optional `set_as_default?: boolean` | `{ workspaceId, apiKey, endpoint?, apiVersion?, set_as_default? }`                                                                                                           | (existing shape)                                                                                                                                                                                                                                                                                               |
| `GET`    | `/api/model-providers?workspaceId=…`         | **Existing — unchanged**                                         | —                                                                                                                                                                            | (existing shape)                                                                                                                                                                                                                                                                                               |
| `POST`   | `/api/credentials`                           | **New**                                                          | `{ workspace_id?: uuid \| null, kind, display_name, plaintext, set_as_default?: boolean }`                                                                                   | `{ id, kind, display_name, workspace_id, scope: 'workspace' \| 'user', created_at }` (no plaintext echo). Used for kinds the existing route can't express (`github_app_install`, `oauth_*`, `aws_credentials`, `openai_compatible_endpoint` with arbitrary `kind`), and for user-only credentials of any kind. |
| `GET`    | `/api/credentials?workspace_id=…&kind=…`     | **New**                                                          | —                                                                                                                                                                            | `{ credentials: [{ id, kind, display_name, workspace_id, scope, created_at, last_used_at? }] }` (union of workspace-scoped + user's user-only of the kind filter; never any plaintext)                                                                                                                         |
| `DELETE` | `/api/credentials/:id`                       | **New**                                                          | —                                                                                                                                                                            | `{ ok: true }` (soft-delete via `revoked_at`)                                                                                                                                                                                                                                                                  |
| `POST`   | `/api/credentials/:id/rotate`                | **New**                                                          | `{ plaintext }`                                                                                                                                                              | `{ id, version }` (atomically replaces `secret_encrypted` + bumps `version`)                                                                                                                                                                                                                                   |
| `POST`   | `/api/credentials/:id/test`                  | **New**                                                          | —                                                                                                                                                                            | `{ ok: bool, error?: string }` (1-token ping per `kind`; reuses `validateModelProviderCredential` for model-provider kinds)                                                                                                                                                                                    |
| `POST`   | `/api/credential-aliases`                    | **New**                                                          | `{ workspace_id?: uuid \| null, user_id?: uuid, alias, credential_id }` (exactly one of workspace_id/user_id set; user_id defaults to acting user when workspace_id is null) | `{ id, alias, scope: 'workspace' \| 'user', credential_id }`                                                                                                                                                                                                                                                   |
| `GET`    | `/api/credential-aliases?workspace_id=…`     | **New**                                                          | —                                                                                                                                                                            | `{ aliases: [{ id, alias, scope, credential_id, credential_display_name }] }` (union of workspace-scoped + user's user-scoped)                                                                                                                                                                                 |
| `DELETE` | `/api/credential-aliases/:id`                | **New**                                                          | —                                                                                                                                                                            | `{ ok: true }`                                                                                                                                                                                                                                                                                                 |

**Auth:** existing user-JWT middleware on every route. Workspace-membership check on every workspace-scoped operation. RLS provides defense in depth.

**Test endpoint per-`kind` behavior** (`apps/api/src/services/credential-tester.ts`):

```ts
const TESTERS: Record<
  string,
  (
    plaintext: string,
    opts?: { endpoint?: string; apiVersion?: string },
  ) => Promise<TestResult>
> = {
  // Model providers — reuse the existing validateModelProviderCredential
  // for all 10 of these. No duplication of provider-pinging logic.
  openai: (k) =>
    validateModelProviderCredential({ provider: "openai", apiKey: k }),
  anthropic: (k) =>
    validateModelProviderCredential({ provider: "anthropic", apiKey: k }),
  xai: (k) => validateModelProviderCredential({ provider: "xai", apiKey: k }),
  google: (k) =>
    validateModelProviderCredential({ provider: "google", apiKey: k }),
  mistral: (k) =>
    validateModelProviderCredential({ provider: "mistral", apiKey: k }),
  groq: (k) => validateModelProviderCredential({ provider: "groq", apiKey: k }),
  openrouter: (k) =>
    validateModelProviderCredential({ provider: "openrouter", apiKey: k }),
  together: (k) =>
    validateModelProviderCredential({ provider: "together", apiKey: k }),
  perplexity: (k) =>
    validateModelProviderCredential({ provider: "perplexity", apiKey: k }),
  azure: (k, o) =>
    validateModelProviderCredential({
      provider: "azure",
      apiKey: k,
      endpoint: o?.endpoint,
      apiVersion: o?.apiVersion,
    }),
  // Non-model-provider kinds — new tester functions
  openai_compatible_endpoint: pingOpenAICompatible,
  github_app_install: pingGitHubAppInstall,
  oauth_subscription: pingOAuthSubscription, // defer concrete impl per OQ-04 open question 5
  oauth_refresh_token: pingOAuthRefresh,
  aws_credentials: pingAWS,
  other: () =>
    Promise.resolve({ ok: false, error: "no tester for kind 'other'" }),
};
```

**Schema additions in PR 1 worth verifying** (or if missing, add to PR 1 before this lands):

- `credential.version int not null default 1` — for rotate audit
- `credential.revoked_at timestamptz` — for soft-delete
- `credential.last_used_at timestamptz` — populated by PR 8 audit-write path

If any of these aren't already in PR 1's schema, add them in this PR's first migration (small, atomic).

**Acceptance criteria:**

- [ ] `POST /api/credentials` with `set_as_default: true` and a `workspace_id` creates / updates the workspace's `default-<kind>` alias in the same transaction.
- [ ] `POST /api/credentials` with `workspace_id: null` creates a user-only credential and (if `set_as_default: true`) creates a user-scoped `default-<kind>` alias.
- [ ] `GET` returns plaintext-equivalent of zero — verified by JSON-shape snapshot test.
- [ ] `POST /api/credentials/:id/test` for each kind hits a stubbed upstream and asserts ok / error mapping.
- [ ] Cross-workspace operations rejected by RLS (and by application-layer guards for defense in depth).
- [ ] Alias collision in same scope (workspace OR user) returns 409.

### PR 5 — `parallel-agent-platform/apps/web`: Credential management UI

**Repo:** `parallel-agent-platform`
**Branch:** `feat/credentials-management-ui`
**Depends on:** PR 4.

**Important — extend, don't duplicate.** The repo already has `apps/web/src/components/settings/ModelsSection.tsx` rendering provider cards with "Connect provider" / "Update key" / `valid` / `credentialConfigured` / `lastError` fields. PR 5 augments that surface with the new concepts (default-for-kind toggle, user-only credentials, aliases) rather than building a parallel page from scratch.

**Files to create / modify:**

- **Modify** `apps/web/src/components/settings/ModelsSection.tsx` — add the "Make this the default for `<provider>` agents" toggle to the Connect / Update flow (wires through `set_as_default` on the existing `POST /api/model-providers/:provider/credentials`). Show a "Default" badge on cards whose credential is the workspace's `default-<provider>` alias target.
- **Create** `apps/web/src/pages/settings/credentials.tsx` — the **richer** view that ModelsSection doesn't cover: user-only credentials, non-model-provider kinds (`github_app_install`, `oauth_*`, `aws_credentials`), the test endpoint, soft-delete, rotate. This page renders sections for "Workspace credentials" (which links into / overlaps with ModelsSection's data) and "Personal credentials" (user-only).
- **Create** `apps/web/src/pages/settings/credential-aliases.tsx` — entirely new (no existing alias surface).
- **Create** `apps/web/src/api/credentials.ts` — thin client wrappers around the new endpoints.
- **Modify** existing agent-creation flow (likely `apps/web/src/pages/onboarding/welcome.tsx` or the settings/agents pages) — add the reuse-existing dropdown that consumes the new `GET /api/credentials?workspace_id=…&kind=…` to surface both workspace-scoped and user-only options.
- **Add** to settings nav routing (whatever pattern the codebase uses) — the new pages slot under Settings → Credentials and Settings → Credential Aliases.

**Settings → Credentials page sketch:**

```
┌──────────────────────────────────────────────────────────────────────┐
│ Credentials                                                  [Add ▾] │
│                                                                       │
│ Workspace credentials                                                 │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Display name      Kind             Default for kind?  Last used  │ │
│ │ ──────────────────────────────────────────────────────────────── │ │
│ │ Team Anthropic    anthropic_api_key  ✓ default          2m ago   │ │
│ │ Team OpenAI       openai_api_key     ✓ default          1h ago   │ │
│ │                                                                   │ │
│ │ [Test] [Rotate] [Make default] [Revoke]                          │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ Personal credentials (only you can use these)                         │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Display name      Kind             Last used                      │ │
│ │ ──────────────────────────────────────────────────────────────── │ │
│ │ My Personal Llama openai_compatible never                         │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

**"Add credential" modal:**

- Kind dropdown (with provider-friendly labels, not raw enum strings)
- Display name input
- Plaintext input (password-masked)
- Scope toggle: "Share with workspace" (default off → user-only) / on → workspace-scoped
- "Make this the default for `<kind>` agents" toggle (only available when scope is workspace, since aliases are namespaced)
- On submit: `POST /api/credentials` with the assembled body
- Success: closes modal, refreshes table, toasts "Added"

**Reuse-existing flow** (to integrate into agent-creation pages):

```tsx
// pseudocode — actual integration depends on agent-creation flow
function AgentCredentialPicker({ agentKind, workspaceId }) {
  const { data: existing } = useCredentials({ workspaceId, kind: agentKind });

  if (existing && existing.length > 0) {
    return (
      <Select label="Use existing credential">
        {existing.map((c) => (
          <Option value={c.id}>
            {c.display_name} <Badge>{c.scope}</Badge>
          </Option>
        ))}
        <Option value="__new__">+ Add a new key</Option>
      </Select>
    );
  }
  return <NewCredentialForm kind={agentKind} workspaceId={workspaceId} />;
}
```

**Acceptance criteria:**

- [ ] Adding a workspace-scoped credential with `set_as_default: true` shows the new row with the "default" badge in the table.
- [ ] Adding a user-only credential lands in the "Personal credentials" section, not the "Workspace credentials" section.
- [ ] Rotate flow: paste new plaintext → table row's `last_used_at` ages out, version increments.
- [ ] Test flow: green check / red X based on stubbed `POST /api/credentials/:id/test` response.
- [ ] Agent-creation page: when the workspace already has an OpenAI credential, the user is offered the dropdown; submitting the form does NOT prompt for a new key.
- [ ] Vitest + React Testing Library coverage of all three flows (add / rotate / test) and the agent-creation reuse path.

### PR 6 — `parallel-agent-runtime`: `Credentials` resolution + lint guards + redaction

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/credentials-resolution`
**Depends on:** PR 2 (encryption helpers in DB).

**Files to create / modify:**

- **Create** `apps/orchestrator/lib/symphony_elixir/credentials.ex`
- **Create** `apps/orchestrator/lib/symphony_elixir/credentials/resolved.ex` — the struct
- **Create** `apps/orchestrator/lib/symphony_elixir/credentials/prompt_redactor.ex` — outbound-prompt scrub
- **Create** `apps/orchestrator/lib/symphony_elixir/credentials/credo_check.ex` (or `priv/credo/credo.exs` config) — Credo lint rule
- **Modify** `apps/orchestrator/lib/symphony_elixir/runner/codex.ex` — switch to `Credentials.resolve`
- **Modify** `apps/orchestrator/lib/symphony_elixir/runner/openclaw.ex`
- **Modify** `apps/orchestrator/lib/symphony_elixir/runner/computer_use.ex`
- **Modify** `apps/orchestrator/lib/symphony_elixir/runner/planner.ex`
- **Modify** the manager runner (when it lands per the manager-agent PR plan)

**`ResolvedCredential` struct:**

```elixir
defmodule SymphonyElixir.Credentials.Resolved do
  @moduledoc """
  Resolved credential. The `plaintext` field is intentional and explicit;
  callers must access via `secret/1` or `with_secret/2`, never via
  string interpolation or `Kernel.inspect/1`.
  """
  @enforce_keys [:id, :kind, :display_name, :user_id]
  defstruct [:id, :kind, :display_name, :workspace_id, :user_id, :_plaintext]

  @type t :: %__MODULE__{
          id: binary(),
          kind: String.t(),
          display_name: String.t(),
          workspace_id: binary() | nil,
          user_id: binary(),
          _plaintext: String.t()
        }

  @doc "Yields the plaintext to the given function and discards it."
  def with_secret(%__MODULE__{_plaintext: pt}, fun) when is_function(fun, 1), do: fun.(pt)

  defimpl Inspect do
    def inspect(c, _opts), do: "#ResolvedCredential<id=#{c.id} kind=#{c.kind} REDACTED>"
  end

  defimpl String.Chars do
    def to_string(c), do: "<ResolvedCredential id=#{c.id} kind=#{c.kind} REDACTED>"
  end
end
```

**`Credentials.resolve/2`:**

```elixir
defmodule SymphonyElixir.Credentials do
  alias SymphonyElixir.Credentials.Resolved

  @type resolve_input ::
          {:credential_id, binary()}
          | {:alias, alias :: String.t(), workspace_id :: binary()}
          | {:kind, kind :: String.t(), workspace_id :: binary(), user_id :: binary()}

  @spec resolve(resolve_input(), ctx :: %{acting_user_id: binary()}) ::
          {:ok, Resolved.t()} | {:error, atom() | tuple()}
  def resolve({:credential_id, id}, ctx), do: resolve_by_id(id, ctx)
  def resolve({:alias, alias, ws}, ctx), do: resolve_by_alias(alias, ws, ctx)
  def resolve({:kind,  kind, ws, uid}, ctx), do: resolve_by_kind(kind, ws, uid, ctx)
  # … private helpers call public.decrypt_credential via the existing
  # Supabase service-role connection
end
```

**Outbound prompt redaction** (middleware in the runner's HTTP-call helper):

```elixir
defmodule SymphonyElixir.Credentials.PromptRedactor do
  @moduledoc """
  Per-process registry of plaintext credential values seen during a turn.
  Outbound LLM-call helpers run prompts through `redact/1` before the wire,
  replacing each registered value with `<redacted>`. Belt-and-suspenders
  against accidental credential leakage in prompts.
  """

  def register(plaintext), do: Process.put({:credential_redact, plaintext}, true)

  def redact(prompt) when is_binary(prompt) do
    Process.get_keys()
    |> Enum.flat_map(fn
      {:credential_redact, pt} when is_binary(pt) -> [pt]
      _ -> []
    end)
    |> Enum.reduce(prompt, fn pt, acc -> String.replace(acc, pt, "<redacted>") end)
  end
end
```

Each runner registers on session start: `PromptRedactor.register(Resolved.secret(credential))`.

**Credo lint rule** (in `priv/credo/credo.exs` or a `Credo.Check` module):

```
Banned substrings in any string literal that lands in:
  - work_item.labels
  - runner_event.payload
  - escalation.payload
  - any %{label: …} or %{labels: …} map under work_item context
Substrings: "secret", "api_key", "access_token", "refresh_token", "bearer"

The check fails CI on any match outside an allowlist (this very PR's
docstrings, test fixtures explicitly tagged @lint_allow).
```

**Runner migration shape** (one example, repeat for each):

```elixir
# Before:
def start_session(config, _workspace) do
  %{api_key: Map.get(config, "api_key"), …}
end

# After:
def start_session(config, _workspace) do
  with {:ok, cred} <- SymphonyElixir.Credentials.resolve(
         resolve_input_from(config),     # build {:credential_id, …} or {:alias, …, …}
         %{acting_user_id: config["user_id"]}
       ) do
    SymphonyElixir.Credentials.PromptRedactor.register(SymphonyElixir.Credentials.Resolved.secret(cred))
    {:ok, %{credential: cred, …}}
  end
end
```

**Acceptance criteria:**

- [ ] `resolve/2` works for all three input shapes against a fixture DB.
- [ ] `inspect(credential)`, string interpolation, and `Jason.encode!(credential)` all render the redacted form.
- [ ] Outbound HTTP request bodies pass through `PromptRedactor.redact/1`; a unit test verifies an `sk-…` value does NOT appear in the wire-level body.
- [ ] Credo run against an artificial fixture file with `[api_key: "sk-…"]` in a `work_item.labels` write fails the build.
- [ ] All four existing runners (`codex`, `openclaw`, `computer_use`, `planner`) are migrated; CI green; integration tests pass.
- [ ] Cross-workspace resolve fails with `{:error, :cross_workspace}`.

### PR 7 — `harper-server` migration: `credential_resolution` audit table

**Repo:** `harper-server`
**Branch:** `migrations/credential-resolution-audit`
**Depends on:** PR 1 (schema baseline). Independent of PR 2; can land in parallel with PR 2 / 3 / 6.

**Files to create:** `supabase/migrations/<ts>_oq04_credential_resolution_audit.sql`

**Schema:**

```sql
create table public.credential_resolution (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references public.workspaces(id) on delete cascade,    -- nullable: a user-only resolve has no workspace
  credential_id uuid not null references public.credential(id) on delete cascade,
  alias         text,                                                        -- the alias used, if resolution was via alias
  work_item_id  uuid references public.work_items(id) on delete set null,
  runner_kind   text,
  resolved_at   timestamptz not null default now()
);

comment on table public.credential_resolution is
  'Audit log: one row per successful Credentials.resolve call. No secret material in any column.';
comment on column public.credential_resolution.workspace_id is
  'NULL when the resolved credential is user-only (no workspace context).';

create index idx_credential_resolution_workspace_time
  on public.credential_resolution (workspace_id, resolved_at desc);
create index idx_credential_resolution_by_credential
  on public.credential_resolution (credential_id, resolved_at desc);
create index idx_credential_resolution_work_item
  on public.credential_resolution (work_item_id) where work_item_id is not null;
```

**Cross-table validation** (consistency, not security — audit rows shouldn't pretend to belong to a workspace the credential isn't in):

```sql
create or replace function public.tg_validate_credential_resolution_workspace()
returns trigger language plpgsql as $$
declare
  v_cred_workspace_id uuid;
begin
  select workspace_id into v_cred_workspace_id
    from public.credential
    where id = new.credential_id;

  -- Audit row's workspace_id may be NULL (user-only resolve) only if the
  -- credential is also user-only.
  if v_cred_workspace_id is distinct from new.workspace_id then
    raise exception 'credential_resolution: workspace_id (%) does not match credential workspace_id (%)',
      new.workspace_id, v_cred_workspace_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_credential_resolution_workspace on public.credential_resolution;
create trigger trg_validate_credential_resolution_workspace
before insert or update on public.credential_resolution
for each row execute function public.tg_validate_credential_resolution_workspace();
```

**RLS** (workspace member SELECT + user SELECT for their user-only resolves; service-role-only inserts):

```sql
alter table public.credential_resolution enable row level security;

create policy credential_resolution_select on public.credential_resolution
for select to authenticated
using (
  (workspace_id is not null and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = credential_resolution.workspace_id
      and wm.user_id = public.current_app_user_id()
  ))
  or (workspace_id is null and exists (
    select 1 from public.credential c
    where c.id = credential_resolution.credential_id
      and c.user_id = public.current_app_user_id()
  ))
);

-- No INSERT/UPDATE/DELETE policies for `authenticated`. Service-role only.
```

**Acceptance criteria:**

- [ ] Insert with workspace_id mismatch (vs the credential's workspace_id) is rejected by the trigger.
- [ ] Workspace member can SELECT their workspace's resolution rows.
- [ ] User can SELECT resolution rows for their user-only credentials regardless of workspace_id field on the audit row.
- [ ] Cross-workspace SELECT denied.

### PR 8 — `parallel-agent-platform` + `parallel-agent-runtime`: write to audit log on resolve

Two coordinated PRs, one per repo. Can land in either order; the audit feature is fully working only after both.

**Repos / branches:**

- `parallel-agent-platform` → `feat/credentials-audit-write`
- `parallel-agent-runtime` → `feat/credentials-audit-write`
- **Depends on:** PR 7 (audit table) + PR 3 (platform resolve service) + PR 6 (runtime resolve service).

**Platform side scope:**

- **Modify** `apps/api/src/services/credentials.ts` — after each successful `resolve` call, fire-and-forget insert into `credential_resolution`. Failure to write does NOT fail the resolve (logged as a warning).
- **Modify** the credentials settings page (PR 5) — add a "Recent usage" tab on each credential row that fetches `GET /api/credentials/:id/resolutions?limit=20`.
- **Create** `apps/api/src/routes/credential-resolutions.ts` — `GET /api/credentials/:id/resolutions` endpoint reading from the new table.

**Runtime side scope:**

- **Modify** `apps/orchestrator/lib/symphony_elixir/credentials.ex` — same fire-and-forget audit write on every successful `resolve/2`.
- **Modify** the `last_used_at` denormalization on `public.credential` (if PR 4 added it): the audit-write also bumps `credential.last_used_at = now()` in the same transaction (or via a small AFTER INSERT trigger on `credential_resolution`).

**Trigger on `credential_resolution` for `last_used_at` denormalization** (lives in PR 7 if you want to keep it close to the table; lives here if denormalization is preferred to be opt-in):

```sql
create or replace function public.tg_credential_resolution_bump_last_used()
returns trigger language plpgsql as $$
begin
  update public.credential
    set last_used_at = new.resolved_at
    where id = new.credential_id;
  return new;
end;
$$;

create trigger trg_credential_resolution_bump_last_used
after insert on public.credential_resolution
for each row execute function public.tg_credential_resolution_bump_last_used();
```

**Failure-mode notes:**

- The write is best-effort: missing audit rows shouldn't fail dispatch.
- The audit endpoint (`GET /api/credentials/:id/resolutions`) is workspace-scoped via RLS; cross-workspace access denied.

**Acceptance criteria:**

- [ ] Each successful platform-side `resolve` produces exactly one `credential_resolution` row.
- [ ] Each successful runtime-side `resolve` produces exactly one row.
- [ ] A simulated DB failure during the audit write does NOT fail the dispatch (log entry confirms warning).
- [ ] `credential.last_used_at` is bumped within ~1s of the `resolve` (whether via the trigger or explicit update — pick one and document).
- [ ] Settings UI's "Recent usage" tab shows the audit rows in reverse-chronological order.

## Open implementation questions

### 1. ✅ Resolved — encryption mechanism is `pgsodium`

Confirmed 2026-04-25. Already installed in this database, native Postgres, no external dependency. Per-workspace key derivation is a well-trodden pattern.

Vault is being deprecated by Supabase. External KMS is overkill at this stage. Revisit only if we hit a compliance regime (FedRAMP, HSM-backed) or move multi-region with cross-region key replication concerns.

### 2. ✅ Resolved — no backfill needed

Confirmed 2026-04-25. No production users yet. PR 1 simply drops the legacy `workspace_id` and `agent_id` columns and adds the new `workspace_id` (nullable, uuid, no default) plus `kind` and `display_name`. If any pre-existing rows happen to violate a new constraint at apply time, the migration fails loudly and the rows can be inspected by hand.

### 3. What happens to `key_value` after encryption rolls out?

The PR 2 plan keeps `key_value` writable during the transition (so legacy code paths don't break), then phases it out. **Recommendation:** add a `deprecated_at` timestamp to credential columns (or a code-level `@deprecated` annotation in the TS types) signaling intent. Drop the column 60 days after the last writer is migrated.

### 4. Credential per-environment splits (dev / staging / prod)

OQ-04 doesn't address this. Probably out of scope for v1; the workspace dimension is enough granularity in the internal-only phase. Worth flagging now so a reviewer doesn't ask later.

### 5. Test endpoint provider coverage

PR 4's `POST /api/credentials/:id/test` needs a per-`kind` check function. v1 covers Anthropic, OpenAI, GitHub. OAuth-bound subscriptions (per OQ-11) need a different shape (refresh token round-trip rather than 1-token completion) — wire when OQ-11 lands.

## Cross-references

- Decision: [OQ-04 per-task model overrides — credentials](./open-questions/oq-04-per-task-model-overrides-credentials.md)
- Adjacent: [OQ-11 OAuth for cloud-running agents](./open-questions/oq-11-oauth-for-runners.md) — depends on this work landing first
- Adjacent: [OQ-03 routing config schema](./open-questions/oq-03-routing-config-schema.md) — `routing_rule.credential_id` references the table this PR plan builds out
- Manager-agent runtime dispatch is the first runtime consumer of `Credentials.resolve`
- Existing schema: `harper-server/supabase/migrations/20260119120000_create_credential_table.sql`, `20260302061000_add_workspace_id_to_credential.sql`
- Existing platform code: `parallel-agent-platform/apps/api/src/repositories/credentials.ts`, `services/setup.ts`, `services/default-agent-credentials.ts`

## Out of scope for this plan

- Per-environment credential splits (dev/staging/prod) — the workspace dimension is enough at this stage.
- HSM-backed keys / external KMS — defer until a real compliance need.
- OAuth-bound credential management UX — that's [OQ-11](./open-questions/oq-11-oauth-for-runners.md), which depends on this work.
- Credential-sharing across workspaces — explicitly disallowed; each workspace owns its own credentials.
