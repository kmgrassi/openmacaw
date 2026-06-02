# Contract Safety PR Plan

This plan addresses the class of failures where one boundary changes but the
adjacent layer only discovers the mismatch at runtime.

The immediate incident had two contract failures:

- Frontend to Platform API: `GET /api/tools` requires `workspaceId`, but the
  UI called the endpoint without it.
- Platform API to database: Platform code and generated types expected
  `tool.workspace_id`, `tool.execution_kind`, `tool.runner_kind`, and
  `tool.enabled`, while the live Harper Server schema did not expose the same
  `tool` shape.

The goal is to make these mismatches fail in CI before merge.

## Principles

- Generated artifacts are never edited by hand.
- Runtime schemas are the source for HTTP contracts.
- Supabase generated types are the source for database contracts.
- Frontend API calls should be generated or typed so required params cannot be
  omitted.
- Cross-repo schema drift should be checked explicitly in CI.

## PR 1: Platform API Contract Registry

Repository: `parallel-agent-platform`

Add a route contract registry for Platform API endpoints. Each route entry
should define:

- method
- path
- path params
- query params
- request body schema
- response schema

Implementation notes:

- Use the existing Zod schemas in `contracts/` where possible.
- Add missing request/response schemas for routes that currently inline params.
- Include `workspaceId` as a required query param for `GET /api/tools` and
  `DELETE /api/tools/:toolId`.
- Include `workspaceId` as a required body field for create/update/assign tool
  requests where the backend requires workspace scope.
- Add API route tests that assert the registry matches the Express route
  behavior for tool routes.

Acceptance criteria:

- `GET /api/tools` cannot be represented in the registry without required
  `workspaceId`.
- Route tests fail if the Express route and contract registry disagree.
- Existing API tests pass.

## PR 2: Typed Frontend API Client From Contracts

Repository: `parallel-agent-platform`

Replace ad hoc frontend API helpers for contract-covered endpoints with a typed
client generated from the Platform API contract registry.

Implementation notes:

- Generate TypeScript helper functions from the registry.
- Keep `brokerFetch` as the transport layer.
- Move query construction into the generated or shared client layer.
- Update the tools settings flow to use the typed helper instead of manually
  building `ROUTES.tools`.
- Add compile-time examples/tests that fail if required params are omitted.

Acceptance criteria:

- Calling the tools list endpoint without `workspaceId` is a TypeScript error.
- Tool create/update/assign helpers require `workspaceId`.
- Existing web build passes with generated client output committed or generated
  in CI consistently.

## PR 3: Supabase Schema Artifact Ownership

Repositories: `harper-server`, `parallel-agent-platform`

Make Harper Server the owner of the generated Supabase schema artifact and make
Platform consume that artifact instead of maintaining an independent manual
copy.

Implementation notes:

- In `harper-server`, keep `src/db/supabaseSchema.ts` generated only by
  `npm run generate-db-types-dev`.
- Add a CI check that runs Supabase type generation and fails when generated
  output differs from the committed file.
- Publish or export the generated schema for Platform consumption. Options:
  - package export from Harper Server,
  - copied artifact via CI/release process,
  - shared package dedicated to database types.
- In Platform, replace local DB type drift with the shared generated type
  artifact.
- Add a guard script that rejects hand edits to generated DB type files unless
  the generation command was run.

Acceptance criteria:

- Platform API code cannot compile against `tool.workspace_id` unless the shared
  generated DB schema includes that column.
- CI fails when Harper Server migrations and generated DB types are out of sync.
- CI fails when Platform consumes stale DB types.

## PR 4: Tool Table Migration And Seed Alignment

Repository: `harper-server`

Add the missing database migration for the tool metadata now expected by
Platform:

- `tool.workspace_id uuid null references public.workspaces(id) on delete cascade`
- `tool.execution_kind text null`
- `tool.runner_kind text null`
- `tool.enabled boolean not null default true`
- indexes needed by tool listing and runner lookup
- seeds for default/global tool definitions

Implementation notes:

- Keep global built-in tools as `workspace_id = null`.
- Workspace-created tools should set `workspace_id`.
- Avoid adding restrictive enum/check constraints until the runner-kind naming
  work is fully settled.
- Regenerate `src/db/supabaseSchema.ts` from the live schema after migration.

Acceptance criteria:

- Platform `/api/tools?workspaceId=...` can query global and workspace tools.
- Generated Harper Server schema includes the new `tool` columns.
- Platform and Harper Server agree on the `tool` row shape.

## PR 5: Cross-Repo Contract CI

Repositories: `parallel-agent-platform`, `harper-server`

Add CI jobs that prove the two repos agree before merge.

Implementation notes:

- Platform CI should run:
  - API tests
  - web build
  - route contract generation/check
  - DB type import/check against the shared schema artifact
- Harper Server CI should run:
  - migration validation
  - generated Supabase type drift check
  - a schema compatibility check for Platform-consumed tables
- Add a small smoke test that boots the API against a migrated test database and
  calls `GET /api/tools?workspaceId=<workspace>`.

Acceptance criteria:

- A missing `workspaceId` frontend call fails at TypeScript compile time.
- A missing DB column fails in CI before Platform code merges.
- The tool settings path has a smoke test that covers list assigned tools and
  list available tools.

## PR 6: Developer And Agent Guardrails

Repositories: `parallel-agent-platform`, `harper-server`

Document and enforce how humans and agents should change contracts.

Implementation notes:

- Add a short `docs/contracts-directory-guidelines.md` update or companion note
  explaining:
  - edit Zod route contracts first for HTTP changes,
  - add migrations first for DB changes,
  - regenerate DB types only via the documented command,
  - never hand-edit generated type files.
- Add generated-file headers where missing.
- Add a lightweight pre-commit or CI check that flags direct edits to generated
  DB type files without a matching migration or generation command.

Acceptance criteria:

- Future agents have explicit repo-local instructions for route and DB contract
  changes.
- Reviewers can identify whether a PR changed HTTP contracts, DB schema, or
  both.
