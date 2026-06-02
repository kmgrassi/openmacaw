# API Typed Supabase Client Refactor PR Plan

Status: shipped. The custom PostgREST wrapper and its compatibility exports
have been removed; this document is retained for historical context.

Scope document for migrating the Express API from a custom PostgREST `fetch`
wrapper to the official typed Supabase client.

The goal is to make all API database calls use Supabase query-builder syntax
with generated database types:

```ts
supabase
  .from("agent")
  .select("id, workspace_id, type, model_settings")
  .eq("id", agentId)
```

Instead of hand-built REST calls:

```ts
supabaseSelect("agent", new URLSearchParams({ id: `eq.${agentId}` }))
```

## Current State

The API is an Express server. It currently does not depend on
`@supabase/supabase-js` in `apps/api/package.json`.

Database access is centralized through
`apps/api/src/supabase-rest-client.ts`, which imports generated database types
but still builds PostgREST requests manually:

- table names are passed as strings;
- filters are encoded as `URLSearchParams`;
- filter values are strings like `eq.<value>` and `in.(...)`;
- some writes use `supabaseInsertRaw` / `supabaseUpdateRaw` with untyped table
  names and bodies;
- tests often mock the wrapper instead of testing query intent through a
  typed repository boundary.

This gives partial type safety for some row bodies, but not enough safety for
filters, selected columns, raw writes, or string-encoded query operators.

## Affected Non-Test Files

Current users of `supabase-rest-client` include:

- `apps/api/src/supabase-rest-client.ts`
- `apps/api/src/supabase.ts`
- `apps/api/src/repositories/agents.ts`
- `apps/api/src/repositories/credentials.ts`
- `apps/api/src/services/agent-control.ts`
- `apps/api/src/services/agent-observation.ts`
- `apps/api/src/services/auth/app-user.ts`
- `apps/api/src/services/credential-resolver.ts`
- `apps/api/src/services/credentials/agent-scope.ts`
- `apps/api/src/services/planning-handoff.ts`
- `apps/api/src/services/plans.ts`
- `apps/api/src/services/runtime-prepare.ts`
- `apps/api/src/services/runtime-target.ts`
- `apps/api/src/services/setup.ts`
- `apps/api/src/services/setup/health.ts`
- `apps/api/src/services/setup/launcher-orchestration.ts`
- `apps/api/src/services/setup/store.ts`
- `apps/api/src/services/work-item-ingest/persistence.ts`

## Target Architecture

Add a server-only Supabase module for the API:

```ts
// apps/api/src/supabase-client.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../supabase/generated/database.types.js";

export type ApiSupabaseClient = SupabaseClient<Database>;

export function getServiceRoleSupabase(): ApiSupabaseClient {
  // reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
}

export function getUserScopedSupabase(accessToken: string): ApiSupabaseClient {
  // uses anon or service key as apikey and the user bearer as Authorization
  // only where RLS/user-scoped auth is intentionally required
}
```

Default API database access should use the service-role client and enforce
authorization in API services before querying or returning data. User-scoped
clients should be rare and explicit.

Keep generated types synced from `supabase/generated/database.types.ts`. Avoid
creating local table/row string unions that duplicate Supabase's generated
types unless they wrap a stable domain boundary.

## Migration Rules

- Prefer `.from(...).select(...).eq(...)`, `.in(...)`, `.insert(...)`,
  `.update(...)`, `.upsert(...)`, and `.delete(...)`.
- Prefer `.single()` / `.maybeSingle()` where the domain expects one row.
- Type returned rows with Supabase's generated inference or narrow explicit
  domain mappers at repository boundaries.
- Do not pass raw `URLSearchParams` for database filters.
- Do not build PostgREST operator strings like `eq.${id}` or `in.(...)`.
- Do not introduce new `fetch("${SUPABASE_URL}/rest/v1/...")` calls.
- If a query shape is complex, hide it behind a repository/service function
  with domain-specific input and output types.

## PR Sequence

### PR 1 — API Supabase Client Foundation

Repository: `parallel-agent-platform`

Deliverables:

- Add `@supabase/supabase-js` to `apps/api`.
- Add `apps/api/src/supabase-client.ts` with:
  - service-role client factory;
  - optional user-scoped client factory;
  - config validation for `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`;
  - shared error normalization helper for Supabase query errors.
- Add unit tests for config validation and singleton/client creation behavior.
- Keep `supabase-rest-client.ts` unchanged for existing call sites.

Acceptance:

- `apps/api` builds with the generated `Database` type.
- No behavior changes to routes.
- New code has a documented rule: new DB calls use the typed client, not the
  REST wrapper.

Parallelism:

- Blocks all later migration PRs.

### PR 2 — Migrate Repository Layer

Repository: `parallel-agent-platform`

Deliverables:

- Convert the smallest shared repositories first:
  - `apps/api/src/repositories/agents.ts`
  - `apps/api/src/repositories/credentials.ts`
- Replace `supabaseSelect`, `supabaseInsert`, `supabaseUpdate`, and
  `supabaseDelete` with typed `.from(...)` calls.
- Keep repository function signatures stable for callers.
- Update tests to mock repository functions or inject a typed client instead of
  asserting URLSearchParams internals.

Acceptance:

- Repository tests cover the same behavior.
- No `supabase-rest-client` import remains in `repositories/agents.ts` or
  `repositories/credentials.ts`.
- Callers do not need behavioral changes.

Parallelism:

- Can run independently from setup/plans once PR 1 lands.

### PR 3 — Migrate Auth, Runtime Target, Runtime Prepare, And Handoff Reads

Repository: `parallel-agent-platform`

Deliverables:

- Convert read-heavy services with limited write behavior:
  - `apps/api/src/services/auth/app-user.ts`
  - `apps/api/src/services/runtime-target.ts`
  - `apps/api/src/services/runtime-prepare.ts`
  - `apps/api/src/services/planning-handoff.ts`
  - `apps/api/src/supabase.ts` read helpers that remain after repository reuse
- Replace `URLSearchParams` filter construction with typed query-builder
  methods.
- Prefer `.maybeSingle()` / `.single()` for single-row reads.

Acceptance:

- Existing auth/setup/runtime tests still pass.
- No PostgREST operator strings remain in those files.
- Missing row and authorization failure behavior is unchanged.

Parallelism:

- Can run after PR 1. It can land before or after PR 2 if it does not depend on
  migrated repository internals.

### PR 4 — Migrate Setup Store And Setup Orchestration

Repository: `parallel-agent-platform`

Deliverables:

- Convert setup-related modules:
  - `apps/api/src/services/setup.ts`
  - `apps/api/src/services/setup/store.ts`
  - `apps/api/src/services/setup/health.ts`
  - `apps/api/src/services/setup/launcher-orchestration.ts`
- Extract repeated gateway-config and default-agent DB operations into
  repository functions if that reduces duplication.
- Replace raw upserts/inserts/updates with typed `.upsert`, `.insert`, and
  `.update`.

Acceptance:

- Setup tests and setup e2e tests pass or are updated to the typed repository
  boundary.
- Default agent creation, credential repair, gateway config versioning, and
  runtime health state remain behaviorally unchanged.
- Setup code no longer imports `supabase-rest-client`.

Parallelism:

- Should be isolated because setup touches many call sites and tests.

### PR 5 — Migrate Plans And Work Item Persistence

Repository: `parallel-agent-platform`

Deliverables:

- Convert:
  - `apps/api/src/services/plans.ts`
  - `apps/api/src/services/work-item-ingest/persistence.ts`
- Replace `supabaseInsertRaw` / `supabaseUpdateRaw` with typed inserts and
  updates against `plan`, `task`, and `work_items`.
- Replace hand-built `in.(...)` helpers with `.in(...)`.
- Preserve rollback behavior for plan/task creation failures.

Acceptance:

- Plan creation/update/delete route tests pass.
- Work item ingest persistence tests pass.
- No raw table-name writes remain in these modules.

Parallelism:

- Can run after PR 1 and independently from setup migration.

### PR 6 — Migrate Agent Control, Observation, Credential Resolver, And Agent Scope

Repository: `parallel-agent-platform`

Deliverables:

- Convert:
  - `apps/api/src/services/agent-control.ts`
  - `apps/api/src/services/agent-observation.ts`
  - `apps/api/src/services/credential-resolver.ts`
  - `apps/api/src/services/credentials/agent-scope.ts`
- Keep credential secret handling and redaction behavior unchanged.
- Prefer domain repositories for repeated credential/agent lookups.

Acceptance:

- Agent control/observation/credential resolver tests pass.
- No `supabase-rest-client` imports remain in these modules.
- No credential secret material is added to errors/logs while refactoring.

Parallelism:

- Can run after PR 1. It may benefit from PR 2's migrated repositories but
  should not need to wait if repository APIs are stable.

### PR 7 — Remove REST Wrapper And Add Guardrails

Repository: `parallel-agent-platform`

Deliverables:

- Delete `apps/api/src/supabase-rest-client.ts`.
- Update all tests that mock the REST wrapper to mock repository/client
  boundaries instead.
- Add a lint/test guard that fails on:
  - `supabase-rest-client` imports;
  - `fetch(.../rest/v1/...)` in `apps/api/src`;
  - `new URLSearchParams` used for Supabase database filters.
- Document the new data-access rule in API docs.

Acceptance:

- `rg "supabase-rest-client" apps/api/src` returns no matches.
- `rg "/rest/v1" apps/api/src` returns no production-code matches.
- `rg "eq\\.\\$\\{|in\\.\\(" apps/api/src` returns no production-code matches
  for Supabase database filters.
- `pnpm --filter apps/api run typecheck` and relevant tests pass.

Parallelism:

- Lands last after PRs 2-6 remove all active call sites.

## Dependency Map

```text
PR 1 typed client foundation
  ├─ PR 2 repositories
  ├─ PR 3 auth/runtime/handoff reads
  ├─ PR 4 setup modules
  ├─ PR 5 plans/work-item persistence
  └─ PR 6 control/observation/credential services
       └─ PR 7 delete REST wrapper + guardrails
```

PR 7 depends on all migration PRs. PRs 2-6 should be kept file-disjoint as much
as possible so they can run in parallel.

## Non-Goals

- Do not change browser Supabase Auth behavior.
- Do not change Supabase schema or generated database types in this refactor
  unless a migration is independently required.
- Do not change route response contracts unless needed to preserve type safety.
- Do not move authorization from API services into RLS as part of this
  migration.
- Do not refactor unrelated upstream provider `fetch` calls.

## Final Acceptance Criteria

- All API database calls use the typed Supabase client/query-builder syntax.
- The custom PostgREST REST wrapper is removed.
- No production API code builds Supabase filter strings like `eq.${value}` or
  `in.(...)`.
- Tests cover behavior at repository/service boundaries instead of asserting
  URL query strings.
- Generated Supabase types remain the source of truth for table row, insert,
  and update shapes.
