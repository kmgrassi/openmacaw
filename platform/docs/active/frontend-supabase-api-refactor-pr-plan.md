# Frontend Supabase API Refactor PR Plan

Scope document for removing direct browser-side Supabase database and realtime
access from the platform web app.

The target rule is:

- Frontend may use Supabase Auth only: sign in, sign up, sign out, session
  lookup, token refresh, and auth-state listeners.
- Frontend must not call Supabase PostgREST, RPC, or Realtime tables directly.
- Database reads/writes and realtime/watch behavior should flow through
  `apps/api` routes that enforce app-level authorization and return typed
  contracts.

## Current Frontend Supabase Usage

Allowed Auth usage:

- `apps/web/src/api/supabase.ts`
  - creates the browser Supabase client and manages auth storage keys.
  - `getSupabaseAccessToken()` reads the current auth session.
- `apps/web/src/stores/auth.ts`
  - `onAuthStateChange`, `getSession`, `signInWithPassword`, `signUp`,
    `signOut`.
- `apps/web/src/hooks/useAuth.ts`
  - older/parallel auth hook using the same Supabase Auth methods.
- `apps/web/src/api/broker-fetch.ts`
  - local Supabase sign-out when the API rejects a stale bearer token.
- `apps/web/src/components/Login.tsx`
  - local sign-out/storage clearing before login.

Direct database/realtime usage to remove:

- `apps/web/src/api/supabase-db.ts`
  - exposes browser-side `fromTable`, `fromView`, and `callRpc` wrappers.
- `apps/web/src/api/agent-dashboard.ts`
  - reads `broker_run`, `broker_task`, and `gateway_config_state` directly.
- `apps/web/src/api/plan-review.ts`
  - reads `task` and `plan` directly.
- `apps/web/src/api/stored-agents.ts`
  - reads/writes `agent`, `credential`, `gateway_config`, and
    `gateway_config_versions` directly.
  - also calls `auth.getUser()` to derive `created_by_user_id`; that should be
    moved to the API using the authenticated request user.
- `apps/web/src/hooks/useAgentDashboard.ts`
  - subscribes directly to Supabase Realtime for `broker_run`, `broker_task`,
    and `gateway_config_state`.

## Desired Shape

```text
browser
  -> Supabase Auth only
  -> platform API with bearer token
  -> API service/repository layer
  -> Supabase service role / typed REST helpers
```

The frontend API modules should use `apiFetch` / `brokerFetch` and shared
contracts. The API server should be responsible for:

- validating the bearer token;
- deriving the app user and workspace access;
- querying Supabase using server-side helpers;
- filtering responses by user/workspace/agent permissions;
- returning typed, minimal response payloads;
- hiding database layout details from the browser.

## PR Sequence

### PR 1 — Shared Contracts And API Route Shells

Repository: `parallel-agent-platform`

Deliverables:

- Add contracts for the response/request shapes needed by:
  - agent dashboard data;
  - plan reviews;
  - stored agent list/create/update;
  - gateway config backend settings for custom agents.
- Add empty or stubbed API route modules under `apps/api/src/routes`.
- Register route prefixes in the API app without changing frontend behavior.
- Add web route constants in `apps/web/src/api/routes.ts`.

Suggested route shape:

- `GET /api/agent-dashboard/:agentId`
- `GET /api/agent-dashboard/:agentId/runs?page=0`
- `GET /api/agent-dashboard/:agentId/events` or a later stream route
- `GET /api/workspaces/:workspaceId/plan-reviews`
- `GET /api/stored-agents`
- `POST /api/stored-agents`
- `PATCH /api/stored-agents/:agentId`
- `GET /api/stored-agents/:agentId/gateway-config`
- `PUT /api/stored-agents/:agentId/gateway-config`

Acceptance:

- Contracts parse current payload needs.
- API route modules are registered and covered by basic auth-required tests.
- No frontend Supabase DB usage is removed yet.

Parallelism:

- Blocks the later implementation PRs only on contract names and route paths.

### PR 2 — Agent Dashboard Reads Move To API

Repository: `parallel-agent-platform`

Deliverables:

- Implement API service for dashboard reads currently in
  `apps/web/src/api/agent-dashboard.ts`.
- Move these Supabase reads server-side:
  - `broker_run` latest run;
  - `broker_run` paginated history;
  - `broker_task` rows for visible runs;
  - `gateway_config_state` for agent/workspace scope.
- Update frontend `agent-dashboard.ts` to call API routes instead of
  `fromTable`.

Acceptance:

- Dashboard still shows latest run, history, task usage, and config state.
- API tests cover user/agent/workspace authorization.
- `apps/web/src/api/agent-dashboard.ts` no longer imports `supabase-db`.

Parallelism:

- Can run after PR 1 and independently from plan review/stored-agent work.

### PR 3 — Plan Review Reads Move To API

Repository: `parallel-agent-platform`

Deliverables:

- Implement `GET /api/workspaces/:workspaceId/plan-reviews`.
- Move direct `task` and `plan` reads from `apps/web/src/api/plan-review.ts`
  into API services.
- Keep evidence extraction either in shared contract-safe utility code or on
  the API side. Prefer API side if the response is already UI-specific.
- Update frontend `plan-review.ts` to call API routes.

Acceptance:

- Plan review UI still shows plans, tasks, and evidence.
- API rejects workspaces the authenticated user cannot access.
- `apps/web/src/api/plan-review.ts` no longer imports `supabase-db` or
  generated DB table types except through shared contracts if needed.

Parallelism:

- Can run after PR 1 and independently from dashboard/stored-agent work.

### PR 4 — Stored Agent Inventory And Mutations Move To API

Repository: `parallel-agent-platform`

Deliverables:

- Move `listStoredAgents`, `createStoredAgent`, and `updateStoredAgent` from
  browser-side Supabase calls into API routes/services.
- Move `upsertCustomGatewayConfig` and `gateway_config_versions` writes into
  API services.
- Derive `created_by_user_id` / `updated_by` from the authenticated API user,
  not `getSupabaseClient().auth.getUser()` in the browser.
- Reuse existing server-side repositories where possible:
  - `apps/api/src/repositories/agents.ts`;
  - `apps/api/src/repositories/credentials.ts`;
  - existing setup/gateway config helper code if it can be extracted cleanly.
- Update frontend `stored-agents.ts` to call API routes only.

Acceptance:

- Settings agent list/create/update behavior is unchanged.
- Custom agent backend config still writes versioned gateway config.
- Browser no longer writes `agent`, `gateway_config`, or
  `gateway_config_versions` directly.
- `apps/web/src/api/stored-agents.ts` no longer imports `supabase-db`,
  `getSupabaseClient`, or generated `Database` types.

Parallelism:

- Can run after PR 1. This is the largest slice and should be isolated from the
  dashboard and plan-review refactors.

### PR 5 — Replace Browser Supabase Realtime Subscriptions

Repository: `parallel-agent-platform`

Deliverables:

- Replace direct Supabase Realtime usage in
  `apps/web/src/hooks/useAgentDashboard.ts`.
- Choose one API-owned update mechanism:
  - API websocket/SSE stream for dashboard invalidation events; or
  - short polling with ETag/version fields as an MVP.
- Server-side stream/poll implementation should watch or query:
  - `broker_run`;
  - `broker_task`;
  - `gateway_config_state`.
- Frontend should subscribe to API events or poll API routes and call the same
  dashboard refresh function.

Recommendation:

- Start with polling if we want the smallest safe PR.
- Use API-owned SSE/websocket when dashboard update latency matters.

Acceptance:

- `useAgentDashboard.ts` no longer imports `@supabase/supabase-js` or
  `getSupabaseClient`.
- Dashboard still updates after runtime run/task/config changes.
- API authorization prevents subscribing to another user's agent/workspace.

Parallelism:

- Can run after PR 2 because it depends on the dashboard API reads.

### PR 6 — Remove Browser DB Helper And Add Guardrails

Repository: `parallel-agent-platform`

Deliverables:

- Delete `apps/web/src/api/supabase-db.ts`.
- Keep `apps/web/src/api/supabase.ts` but narrow its public exports to Auth
  functionality.
- Add a lint or test guard that fails if frontend code imports:
  - `fromTable`;
  - `fromView`;
  - `callRpc`;
  - `@supabase/supabase-js` outside the approved auth module/type-only
    exceptions.
- Add a docs note to `contracts-directory-guidelines.md` or a new frontend API
  guideline explaining that browser data access goes through `apps/api`.

Acceptance:

- `rg "fromTable\\(|fromView\\(|callRpc\\(" apps/web/src` returns no matches.
- `rg "@supabase/supabase-js" apps/web/src` is limited to the approved auth
  module and optional type-only auth imports.
- Existing web build passes.

Parallelism:

- Should land last after PRs 2-5 remove the active call sites.

## Dependency Map

```text
PR 1 contracts/routes
  ├─ PR 2 dashboard reads
  │    └─ PR 5 realtime replacement
  ├─ PR 3 plan review reads
  └─ PR 4 stored agent mutations
       └─ PR 6 delete helper + guardrails
```

PR 6 depends on all direct database/realtime call sites being gone.

## Non-Goals

- Do not remove Supabase Auth from the browser.
- Do not change the user's login/session behavior except where stale-token
  clearing is already needed.
- Do not expose service-role behavior to the browser.
- Do not rewrite unrelated API clients that already call platform API routes.
- Do not redesign dashboard UI or settings UI as part of this migration.

## Final Acceptance Criteria

- The browser uses Supabase only for Auth.
- No browser code calls `.from`, `.rpc`, or `.channel` on the Supabase client.
- API routes own all database reads/writes.
- API tests cover authorization for every moved route.
- Frontend API modules consume typed contracts instead of generated database row
  types where practical.
