# Execution Target Schema PR Plan

Today an agent's execution target lives inside the free-form
`agent.tool_policy` JSONB column under `executionTarget.kind`. The API
parses it at runtime in
[`runtime-dispatch-context.ts`](../../apps/api/src/services/runtime-dispatch-context.ts)
and rejects invalid kinds with a 422. This plan promotes the field to a
real DB column with a CHECK constraint so the database is the source of
truth for which agents run on the local helper vs. a container, and so
malformed values cannot land in the table at all.

This plan implements item 2 from the PR
[#298](https://github.com/kmgrassi/parallel-agent-platform/pull/298)
follow-up discussion.

## Principles

1. **No transitional column.** Per
   [CLAUDE.md → No Backwards Compatibility Shims](../../CLAUDE.md#no-backwards-compatibility-shims),
   we don't dual-write or dual-read. The migration adds the new column,
   backfills from JSONB, and switches the service layer in the same PR.
2. **DB constraints enforce correctness.** A CHECK constraint on the
   new column rejects any kind outside `('local_helper','container')`
   at write time — the API layer's runtime check becomes a defense in
   depth, not the only line of defense.
3. **Container metadata stays per-request, not per-agent.** Repository
   source / limits / artifact retention / network policy are
   request-scoped (each dispatch picks a different commit, for
   instance). They continue to flow through the request body, validated
   by `ContainerExecutionDispatchMetadataSchema`. The DB column only
   captures the *kind* that this agent is configured to run as.
4. **Existing rows default to `local_helper`.** That is the only kind
   that has shipped to date, so the backfill is unambiguous.

## Schema change

Single migration on `harper-server` (or wherever `agent` lives —
confirm before drafting):

```sql
ALTER TABLE agent
  ADD COLUMN execution_target_kind text NOT NULL
    DEFAULT 'local_helper'
    CHECK (execution_target_kind IN ('local_helper', 'container'));

-- Backfill any rows that already set tool_policy.executionTarget.kind
UPDATE agent
SET execution_target_kind = tool_policy->'executionTarget'->>'kind'
WHERE tool_policy->'executionTarget'->>'kind' IN ('local_helper', 'container');

-- Drop the JSONB key so there's only one source of truth.
UPDATE agent
SET tool_policy = tool_policy - 'executionTarget'
WHERE tool_policy ? 'executionTarget';
```

We keep `DEFAULT 'local_helper'` rather than dropping the default after
backfill — new agents created via the API don't have to opt-in to a
kind explicitly, and the default matches today's behavior.

## API changes

1. **Repository layer** — extend `SetupAgentRow` to include
   `execution_target_kind`. The mapping in
   [`agents.ts`](../../apps/api/src/repositories/agents.ts) returns it as
   `executionTargetKind` (camelCase) per the
   [field naming convention](../../CLAUDE.md#field-naming-conventions-case-style).
2. **Dispatch builder** — replace
   `configuredExecutionTargetKind(agent.tool_policy)` in
   [`runtime-dispatch-context.ts`](../../apps/api/src/services/runtime-dispatch-context.ts)
   with a direct read of `agent.executionTargetKind`. The 422
   `invalid_execution_target` path goes away — the DB CHECK already
   guarantees the kind is valid.
3. **Agent setup endpoints** — expose `executionTargetKind` on the
   agent create / update request schemas, and persist it in the
   `agent` upsert. Web setup UI gets a toggle (out of scope for the DB
   PR; flag-gated until the container runner ships end-to-end).
4. **Tests** — `proxy-runtime-dispatch.test.ts` mocks
   `findSetupAgentById` to return rows with
   `executionTargetKind: 'container'` instead of stuffing a value into
   `tool_policy.executionTarget`.

## Validation gates

```bash
pnpm -C apps/api run validate
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json
pnpm -C packages/plan-schema run test
```

Plus a manual check that an existing local-coding agent in the dev
workspace still dispatches successfully after the migration runs.

## Out of scope

- Generic `resolveExecutionTarget(agentId)` that branches by runner
  kind — file separately, after the column lands and we have a real
  second runner using it (probably the container coding runner from
  [#298](https://github.com/kmgrassi/parallel-agent-platform/pull/298)).
- Renaming the `type` discriminator on `RepositorySource`,
  `CredentialReference`, etc. to `kind` for consistency. Tracked
  separately.
- Storing per-agent default container metadata (limits, network
  policy). Each dispatch supplies its own metadata today; if we ever
  want agent-level defaults we can add a sibling JSONB column with a
  Zod-validated shape, but it's not needed for the kind switch.
