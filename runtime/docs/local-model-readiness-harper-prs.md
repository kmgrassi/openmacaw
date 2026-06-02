# Local-Model Readiness — Harper-Server PR Plan

Repo: `harper-server` (Supabase migrations).

See [local-model-readiness-scope.md](local-model-readiness-scope.md)
for the master design.

> **Note:** this file lives in the runtime repo for cross-repo
> planning. Copy to `harper-server/docs/` when work begins so the
> migration PR has the scope checked in alongside it.

---

## PR1 — `local_runtime_token` schema for runtime-side validation

**Branch:** `feat/local-runtime-token-table` ([harper-server#509](https://github.com/harper-hq/harper-server/pull/509))

**Status: mostly already done.** Migration
`20260425140000_oq02_local_runtime_tables.sql` already creates
`public.local_runtime_token` with the columns the runtime DB-backed
validator needs:

- `id`, `machine_id`, `workspace_id`, `token_hash` (unique)
- `last_used_at` (the runtime PR3 doc below calls this `last_seen_at`
  — runtime should rename to match this column)
- `revoked_at`, `created_at`
- Active-token index on `token_hash` where `revoked_at IS NULL`
- Workspace-consistency trigger ensuring token's `workspace_id`
  matches the parent machine's `workspace_id`

**The runtime can use this table as-is.** This "PR1" reduces to
optional, additive follow-ups:

- `created_by_user_id` (audit) — recommended, low cost.
- `expires_at` (token TTL) — deferred unless short-lived tokens
  become a product requirement.

**Original goal (now mostly satisfied):** provide the schema that
runtime PR3 will validate against. The dev-mode env-based adapter
in `LocalRelay.TokenValidator.Config` doesn't satisfy production
needs.

**Note on existing infrastructure:** the platform already has a
`local_runtime_machine` table and one-time token issuance flow on
`/settings/local-models` (via apps#349). This PR formalizes the
**hash storage** and **validation surface** that the runtime needs.
If a `local_runtime_token` table already exists (check before
writing the migration), this PR is just adding fields and indexes
the runtime requires.

**Migration:**

```sql
-- Verify whether table already exists from apps#349 work first.
-- If it does, this becomes ALTER TABLE; if not, CREATE TABLE.

CREATE TABLE IF NOT EXISTS public.local_runtime_token (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  machine_id      uuid NOT NULL REFERENCES public.local_runtime_machine(id) ON DELETE CASCADE,
  token_hash      text NOT NULL,         -- SHA-256 hex of the plaintext token
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  expires_at      timestamptz,           -- nullable = never expires
  revoked_at      timestamptz,           -- nullable = active
  created_by_user_id uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS local_runtime_token_workspace_active_idx
  ON public.local_runtime_token (workspace_id)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS local_runtime_token_hash_active_idx
  ON public.local_runtime_token (token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS local_runtime_token_machine_idx
  ON public.local_runtime_token (machine_id);

-- RLS policy: only service-role can read (runtime), only platform-API
-- can insert (token issuance) and update (rotation/revocation).
-- Confirm with platform team before locking down policies.
```

**Schema sync (per CLAUDE.md):**

After this migration lands, the runtime must run
`pnpm run supabase:schema:sync` to regenerate the bridge schema
files. Add `local_runtime_token` to `BRIDGE_TABLES` in
`scripts/append-supabase-jsdoc-types.mjs` if not already present —
runtime PR3 reads this table directly via PostgREST.

**Acceptance criteria:**
- [ ] Migration applies cleanly on a copy of prod.
- [ ] `token_hash` is unique among non-revoked tokens (prevents
  replay-after-rotate edge case).
- [ ] `last_seen_at` can be updated by the runtime on each successful
  validation (best-effort; the column being null is fine).
- [ ] RLS policies prevent cross-workspace token reads.
- [ ] Runtime's bridge schema regenerates with `local_runtime_token`
  available.

**Sequencing:** First in the cross-repo sequence for PR3. Runtime
PR3 reads from this table.

**Size:** ~30 lines of SQL + RLS policies.

---

## What is *not* in scope for this repo

- Token issuance / rotation / revocation API lives in the platform
  (already partly built via apps#349). This PR is schema-only.
- The runtime's validator adapter lives in
  [runtime PR3](local-model-readiness-runtime-prs.md).
