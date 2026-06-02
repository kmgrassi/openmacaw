# Local Runtime Shared Routes PR Plan

## Goal

Finish one contained slice of the shared-route cleanup by moving the local
runtime HTTP path builders into [`contracts/routes.ts`](../../contracts/routes.ts)
and making both API route registration and the web local-runtime client consume
them.

## Scope

- Add local-runtime route templates and path builders in `contracts/routes.ts`.
- Replace literal local-runtime route strings in
  `apps/api/src/routes/local-runtime.ts` with the shared templates.
- Replace local-runtime path construction in
  `apps/web/src/api/local-runtime.ts` with the shared builders.

## Non-Goals

- Do not migrate unrelated `/api/*` routes in the same PR.
- Do not change request/response schemas or route behavior.
- Do not refactor the broader `apps/web/src/api/routes.ts` surface yet.

## Acceptance Criteria

- API and web use the same source of truth for local-runtime route shapes.
- The generated paths remain unchanged.
- Validation passes:
  - `pnpm -C apps/api run validate`
  - `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`
