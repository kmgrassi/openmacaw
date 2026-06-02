# Frontend Data Refresh with React Query

React Query is the web app's cache for API-backed server state. Components
should keep local UI state locally, but durable data from `apps/web/src/api/*`
belongs behind query keys and mutation invalidation.

## Freshness Classes

- `live`: message histories and active runtime data. Use short stale times and
  Gateway event invalidation.
- `runtime`: dashboard, health, sessions, and diagnostics. Use short stale
  times plus scoped invalidation after runtime events and worker actions.
- `persisted`: setup, agents, tools, plans, work items, credentials, local
  models, manager config, and scheduled tasks. Prefer mutation-driven
  invalidation with a modest stale time.
- `static`: catalogs, templates, and mostly static config. Use longer stale
  times and invalidate only after mutations that can change those lists.

## Query Keys

All query keys come from `apps/web/src/api/query-keys.ts`. Do not create string
literal keys in components. Missing ids should use disabled queries with the key
factory's `null` sentinel rather than fake data.

## Mutations

Mutations should call existing typed API client functions, then invalidate with
`invalidateForReason()` or `invalidateQueryTargets()`. Pick the narrowest
reason/scope that covers every visible dependent surface.

## Gateway Events

Gateway events flow through
`apps/web/src/api/gateway-query-invalidation.ts`. Final chat, turn, run, tool,
usage, plan, and work-item events map to scoped query invalidations. Streaming
token deltas remain local UI state and should not refetch durable data.

## Cross-tab Behavior

`installCrossTabQuerySync()` uses TanStack's broadcast client in production so
query updates and invalidations in one tab are visible in other open tabs. Do
not gate this behavior behind development flags.

## Audit Notes

Direct `apiFetch`, `brokerFetch`, and API client calls are acceptable in
`apps/web/src/api/*` modules and action-only helpers such as local directory
pickers, smoke tests, and one-shot diagnostic exports. Components and hooks that
display durable server state should move those calls behind query or mutation
hooks as they are migrated.
