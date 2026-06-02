# Unified Tool Contract — Harper-Server PR Plan

Repo: `harper-server` (Supabase migrations).

See [unified-tool-contract-scope.md](unified-tool-contract-scope.md) for
the master design.

> **Status:** This older bundle/override migration has been superseded by
> the grant model described in
> [agent-tool-grant-data-model-runtime-scope.md](agent-tool-grant-data-model-runtime-scope.md).
> Harper Server should persist templates as write-time presets and
> `agent_tool_grant` rows as the runtime-effective tool set.

> **Note:** this file lives in the runtime repo for cross-repo planning.
> When work begins, copy to `harper-server/docs/` so the PR plan is
> checked in alongside the migration.

---

## PR1 — Per-agent tool grant schema

**Branch:** `feat/agent-tool-grants`

**Goal:** Store the effective tools an agent may expose to a model.
Templates may materialize default rows, but Runtime reads grants only.

**Migration sketch:**

```sql
CREATE TABLE public.tool_policy_template (...);

CREATE TABLE public.agent_tool_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agent(id),
  tool_id uuid NOT NULL REFERENCES public.tool(id),
  enabled boolean NOT NULL DEFAULT true,
  grant_source text,
  source_tool_template_id uuid REFERENCES public.tool_policy_template(id),
  config jsonb NOT NULL DEFAULT '{}',
  policy jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, tool_id)
);

COMMENT ON TABLE public.agent_tool_grant IS
  'Effective per-agent tool grants consumed by runtime tool resolution.';
```

**Backfill:**
- Existing agents receive explicit `agent_tool_grant` rows matching their
  current effective tool lists.
- Template provenance may be recorded, but the grant rows remain the
  runtime source of truth.

**Schema sync (per CLAUDE.md):**

After this migration lands, runtime must run `pnpm run supabase:schema:sync`
to regenerate the bridge schema files.

**Acceptance criteria:**
- [ ] Migration applies cleanly on a copy of prod
- [ ] Backfill produces explicit grants for all existing agents
- [ ] No existing tool resolution breaks before runtime consumes grants
- [ ] `BRIDGE_TABLES` in `scripts/append-supabase-jsdoc-types.mjs`
  (runtime repo) includes the grant and tool tables needed by runtime

**Sequencing:** First in the cross-repo sequence. Runtime PR1 expects
the grant contract to be documented, but registry-only runtime changes can
land before direct DB grant resolution.
