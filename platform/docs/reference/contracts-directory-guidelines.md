# Contracts Directory Guidelines

This repo uses `contracts/` for shared application boundary definitions.

The purpose of this directory is narrow:

- define request and response shapes shared across package boundaries
- define schemas that validate data crossing those boundaries
- provide a single source of truth for wire-level data models used by more than one app

In this repo, that primarily means data shared between:

- `apps/api`
- `apps/web`
- worker or launcher integration surfaces when both sides must agree on payload shape

## What belongs in `contracts/`

Put something in `contracts/` when all of these are true:

1. It represents a boundary, not just an internal implementation detail.
2. More than one package or process needs the exact same shape.
3. Drift between copies would cause a real bug, runtime failure, or confusing behavior.
4. The shape is stable enough that it is worth treating as part of the repo's public internal API.

Good examples:

- HTTP request and response bodies shared by API server and frontend
- worker bridge payloads shared by API and web
- credential activation response schemas used in both the server and client
- shared validation schemas for persisted or transmitted payloads

## What does not belong in `contracts/`

Do not put something in `contracts/` if any of these are true:

- it is only used inside one package
- it is a UI-only view model or component prop type
- it is a database row type already generated from Supabase
- it is a helper type created only to make one implementation easier to write
- it changes frequently with local refactors and is not a real boundary
- it contains business logic instead of shape definition and validation

Those should usually live closer to the code that owns them:

- `apps/web/src/...` for UI and client-only models
- `apps/api/src/...` for server-only internal shapes
- `packages/supabase-schema/...` for the generated database schema artifact

## Decision rule

Use this test before adding a new file to `contracts/`:

"If I duplicated this type in each consumer, would that create meaningful contract drift risk?"

If the answer is yes, it likely belongs in `contracts/`.
If the answer is no, it likely belongs with the local implementation.

## Preferred contents

Files in `contracts/` should stay boring and predictable.

Prefer:

- Zod schemas
- exported inferred TypeScript types
- small enums and literal unions tied to transport shape
- minimal helpers directly related to schema definition

Avoid:

- fetch logic
- React code
- database access
- environment-dependent behavior
- side effects
- large transformation utilities

## Naming guidance

`contracts/` is a reasonable name here.

Why it works:

- these files define agreements between parts of the system
- they are more than plain TypeScript types because they also include validation schemas
- "contract drift" is the actual failure mode this directory is meant to prevent

Alternative names like `schemas/` or `shared-types/` would be less precise:

- `schemas/` suggests any validation schema, including local-only ones
- `shared-types/` suggests compile-time types only, but these files also define runtime validation

So the recommendation is:

- keep the directory name as `contracts/`
- keep the scope tight
- avoid turning it into a generic dumping ground for reusable types

## Package boundary note

Because `contracts/` is imported from multiple app packages, it should be treated as its own module boundary.

That is why this directory includes its own [package.json](../../contracts/package.json) declaring `"type": "module"`.

If you add files here, assume they may be loaded by different package runtimes, not just by TypeScript.

## Frontend Supabase Boundary

Browser code may use Supabase only for Auth concerns: session lookup, token refresh, auth-state listeners, sign-in,
sign-up, and sign-out. Browser database reads, writes, RPC calls, and realtime table subscriptions must go through
`apps/api` routes with shared request/response contracts.

Keep `apps/web/src/api/supabase.ts` as the only frontend module that imports `@supabase/supabase-js`. It should expose
auth-oriented helpers only. New frontend data modules should call `apiFetch` or `brokerFetch` and validate API responses
with schemas from `contracts/` when the payload crosses the web/API boundary.

## Contract Change Order

Contract changes should start at the source of truth for the boundary being changed.

For HTTP contracts:

1. Update or add the Zod request/response schemas in `contracts/` first.
2. Update API route behavior to parse and return the new schema shape.
3. Update web callers to use the shared schema or typed client helper instead of duplicating request shape.
4. Add or update route tests that prove required path, query, body, and response fields match the schema.

For database contracts:

1. Add the Supabase migration first in `supabase/migrations/`.
2. Apply the migration to the intended Supabase project or local database.
3. Regenerate `packages/supabase-schema/src/database.types.ts` with `pnpm run db:schema:sync`.
4. Update API code to use the regenerated types. Do not patch missing generated entries by hand.

Never hand-edit generated database type files. If `packages/supabase-schema/src/database.types.ts` is wrong, fix the
schema state or sync command, then regenerate and sync it. Review generated type diffs alongside the migration that
caused them.

## Review Signals

PRs that touch contracts should make the boundary explicit for reviewers:

- HTTP contract changed: list the `contracts/` files and API routes affected.
- DB schema changed: list the migration files and confirm `pnpm run db:schema:sync` was run.
- Both changed: explain how the HTTP/API behavior maps onto the DB migration.
- Neither changed: say so in the PR checklist so reviewers know contract guardrails were considered.
