# Query Invalidation Large-File Refactor

Status: active. Created 2026-05-24.

## Goal

Split [`apps/web/src/api/query-invalidation.ts`](../../apps/web/src/api/query-invalidation.ts)
into smaller, behavior-preserving modules so the React Query invalidation layer
is easier to extend and review.

## Scope

- Keep the existing public import path: `apps/web/src/api/query-invalidation.ts`
  remains the facade.
- Extract shared invalidation types and target helpers.
- Extract reason-to-target mapping logic.
- Extract higher-level convenience invalidators used by hooks and mutations.
- Keep behavior stable; no query-key or invalidation-shape changes.

## Proposed Files

- `apps/web/src/api/query-invalidation/types.ts`
- `apps/web/src/api/query-invalidation/targets.ts`
- `apps/web/src/api/query-invalidation/reasons.ts`
- `apps/web/src/api/query-invalidation/convenience.ts`

## Validation

- `pnpm exec vitest run apps/web/src/api/query-invalidation.test.ts apps/web/src/api/gateway-query-invalidation.test.ts`
- `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`
