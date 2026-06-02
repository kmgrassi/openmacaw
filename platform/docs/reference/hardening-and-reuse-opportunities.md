# Hardening and Reuse Opportunities

This document captures concrete places where the repo can reduce duplication, centralize cross-cutting behavior, and make future changes safer. It is based on a scan of the current API gateway, web client, contracts, and Supabase access layers.

## Goals

- Keep request validation, auth, error responses, and response parsing consistent.
- Move repeated data-shaping logic into domain helpers with tests.
- Make React data-loading code less repetitive and less error-prone.
- Reuse shared contracts and route definitions across API, web, and tests.
- Improve observability and failure handling without large rewrites.

## High-Value Refactor Candidates

| Area | Current Pattern | Reuse Opportunity | Suggested Location | Priority |
| --- | --- | --- | --- | --- |
| Express route boilerplate | Routes repeat `safeParse`, bearer-token checks, `try/catch`, and `errorPayload` responses. | Add route wrappers/middleware for auth, body validation, query validation, and async error mapping. | `apps/api/src/http.ts`, `apps/api/src/middleware/` | High |
| Web fetch clients | `setupFetch`, `workerBridgeFetch`, `credentials` fetches, `broker` fetches, and `runtime-agents` each parse text/JSON and build errors. | Create one typed `apiFetch` helper with auth options, schema parsing, broker base URL handling, and normalized `ApiClientError`. | `apps/web/src/api/client.ts` | High |
| Supabase query construction | Many files hand-build `URLSearchParams`, repeat select strings, and cast rows. | Add small repository helpers for common table projections and filters. Keep column lists in constants. | `apps/api/src/repositories/`, `apps/web/src/api/repositories/` | High |
| Agent/model helpers | `asRecord`, `extractPrimaryModel`, and `deriveProvider` exist in both API and web. | Move shared pure helpers into a contract/domain utility package and test once. | `contracts/agents.ts` or `contracts/agent-helpers.ts` | High |
| Stored credential flow | Credential mapping, provider aliases, masking, launchability, and secret resolution are spread across setup, Supabase access, and route handlers. | Create a credential domain module for provider metadata, sanitized DTOs, env var mapping, labels, and launchability checks. | `apps/api/src/services/credentials-domain.ts`, optionally shared metadata in `contracts/credentials.ts` | High |
| Worker launch activation | `/credentials/:credentialId/launch` and `/activate` repeat validation, secret resolution, OpenAI credential validation, session creation, and launch payload shaping. | Extract `validateAndLaunchStoredCredential(...)` with options for selected credential vs first launchable credential. | `apps/api/src/services/stored-agent-activation.ts` | High |
| React loading state | Hooks and settings sections repeat `loading/error/setLoading/setError/try/finally` patterns. | Add `useAsyncTask`, `useAsyncResource`, or migrate repeated server state to a small query abstraction. | `apps/web/src/hooks/useAsyncResource.ts` | Medium |
| Status badges | Multiple components map statuses to badge variants and labels independently. | Add `statusVariant`, `statusLabel`, and domain-specific status maps. | `apps/web/src/components/ui/status.ts` or `apps/web/src/lib/status.ts` | Medium |
| Settings panels | Settings sections repeat section headers, refresh buttons, error callouts, empty cards, and table wrappers. | Add `SettingsSectionShell`, `ErrorCallout`, `EmptyState`, `DataTable`, `KeyValueList`. | `apps/web/src/components/ui/` and `apps/web/src/components/settings/` | Medium |
| Route constants | Web owns route constants, while API route registration uses literal strings. | Move route path builders to shared contracts so API, web, and tests use the same paths. | `contracts/routes.ts` | Medium |
| JSON parsing | Server and client both repeatedly parse best-effort JSON from text. | Add `parseJsonLike`, `readJsonResponse`, and `parseErrorBody` helpers. | `apps/api/src/http.ts`, `apps/web/src/api/client.ts` | Medium |
| Config parsing | Config/env parsing includes several one-off parsers and fallback helpers. | Add typed env parsing helpers: required string, optional URL, positive int, JSON record/map. | `apps/api/src/config-helpers.ts` | Medium |
| Test setup | API tests likely need repeated launcher, Supabase, and request mocks as coverage grows. | Add test fixtures for fake launcher responses, Supabase REST responses, auth headers, and signed webhook bodies. | `apps/api/src/test-utils/` | Medium |
| Observability | Launcher client logs structured events, but route-level requests and Supabase failures are less consistently correlated. | Add request ID middleware, structured request logger, and error metadata normalization. | `apps/api/src/middleware/request-context.ts` | Medium |

## PR-Sized Roadmap

Each PR below is intended to be small enough to review independently. Later PRs can be reordered when they do not depend on previous code, but the listed order keeps the riskiest shared primitives early and avoids mixing server, client, and UI refactors in the same review.

| Done | PR | Scope | Files/Areas | Acceptance Criteria |
| --- | --- | --- | --- | --- |
| [x] | PR 1 | Add a shared web API client and migrate two callers. | `apps/web/src/api/client.ts`, `apps/web/src/api/setup.ts`, `apps/web/src/api/worker-bridge.ts` | One fetch helper handles broker base URL, JSON/text parsing, schema parsing, auth headers, and normalized client errors. Existing setup and worker bridge behavior stays equivalent. |
| [x] | PR 2 | Add API route error primitives and migrate setup routes. | `apps/api/src/http.ts`, `apps/api/src/routes/setup.ts`, setup route tests | Generic API route errors and auth/body validation helpers exist. Setup routes no longer hand-roll bearer-token and Zod failure responses. |
| [x] | PR 3 | Extract shared agent/model helpers. | `contracts/agent-helpers.ts`, `apps/api/src/supabase.ts`, `apps/web/src/api/stored-agents.ts` | API and web both use the same `asRecord`, model extraction, and provider derivation helpers. Helper behavior is covered by focused tests. |
| [x] | PR 4 | Centralize credential provider metadata. | `contracts/credentials.ts` or `apps/api/src/services/credentials-domain.ts`, `apps/api/src/supabase.ts`, `apps/api/src/services/setup.ts` | Provider aliases, env vars, labels, last-4 masking, and launchability come from one registry. Stored credential output is unchanged. |
| [ ] | PR 5 | Extract stored-agent activation service. | `apps/api/src/services/stored-agent-activation.ts`, `apps/api/src/routes/stored-agents.ts` | Specific credential launch and agent activation share one tested service path for credential selection, secret resolution, validation, and worker session creation. |
| [x] | PR 6 | Start Supabase repository extraction with agents and credentials. | `apps/api/src/repositories/agents.ts`, `apps/api/src/repositories/credentials.ts`, callers in setup/stored-agent services | Common agent and credential queries moved out of service/route files. Low-level REST client remains unchanged. |
| [ ] | PR 7 | Add React async resource/task helpers and migrate narrow callers. | `apps/web/src/hooks/useAsyncResource.ts`, `apps/web/src/hooks/useAgents.ts`, `apps/web/src/hooks/useSessions.ts` | Basic loading/error/reload boilerplate is centralized. Hooks preserve current return shapes. Race-protected hooks such as `useAgentDashboard` are left for a later targeted PR. |
| [ ] | PR 8 | Add shared UI status and state primitives. | `apps/web/src/components/ui/StatusBadge.tsx`, `ErrorCallout.tsx`, `EmptyState.tsx`, selected dashboard/settings components | Status-to-badge mapping, error callouts, and empty states are reusable. Only a small set of representative components is migrated. |
| [ ] | PR 9 | Move route builders into shared contracts. | `contracts/routes.ts`, `apps/web/src/api/routes.ts`, selected API route tests | Shared route constants cover paths used by both API and web. Web keeps a compatibility export if needed. API tests or smoke checks use the shared constants. |
| [ ] | PR 10 | Add validation and smoke-test tooling. | root `package.json`, `scripts/smoke-api.sh`, docs updates | A root validation command exists. Smoke tests document/check the key broker paths. Tooling does not require live secrets unless clearly documented. |
| [ ] | PR 11 | Add request context and structured route observability. | `apps/api/src/middleware/request-context.ts`, `apps/api/src/app.ts`, error/log helpers | Requests receive a stable request ID. Route errors and launcher/Supabase failures can include request context without leaking secrets. |

### Implementation Status

- [x] PR 1 — Shared web API client and setup/worker bridge caller migration completed in `apps/web/src/api/client.ts`, `apps/web/src/api/setup.ts`, and `apps/web/src/api/worker-bridge.ts`.
- [x] PR 2 — API route error primitives and setup route migration completed in `apps/api/src/http.ts`, `apps/api/src/routes/setup.ts`, and `apps/api/src/routes/setup.test.ts`.
- [x] PR 4 — Credential provider metadata registry completed in `contracts/credentials.ts`, with API credential projection and setup credential JSON now using the shared registry.
- [x] PR 3 — Shared agent/model helpers completed in `contracts/agent-helpers.ts`, with API and web callers migrated in `apps/api/src/supabase.ts` and `apps/web/src/api/stored-agents.ts`.
- [x] PR 6 — Supabase repository extraction started with agent and credential repositories. Setup and stored-agent service callers now use domain-focused repository functions while keeping the REST transport helpers unchanged.

### PR Dependency Notes

- PR 1 can land independently and should be the first client-side cleanup.
- PR 2 should land before broad API route migrations so the pattern is proven on `setup.ts`.
- PR 3 and PR 4 can be done in either order, but PR 4 becomes easier after PR 3 removes duplicated model/provider helpers.
- PR 5 should follow PR 4 if credential provider metadata is part of the launchability decision.
- PR 6 should happen after PR 3 and PR 4 so repository functions can return domain-shaped values without duplicating helper logic.
- PR 7 and PR 8 are independent of the API work and can be done in parallel with PR 3 through PR 6.
- PR 9 is safer after route behavior settles, but it can be pulled earlier if tests need shared route constants.
- PR 10 can land at any time, though smoke tests become more valuable after PR 9.
- PR 11 is intentionally late because request-context plumbing touches broad API behavior.

### PR Template for Each Follow-Up

Use this checklist when converting any roadmap item into an implementation PR:

- **Scope:** Name the exact helper or module being introduced and the first callers being migrated.
- **Non-goals:** List nearby duplicate code that is intentionally left for later PRs.
- **Compatibility:** State whether request/response contracts, UI output, or database writes should remain unchanged.
- **Tests:** Add focused unit tests for pure helpers and route/client tests for behavior-preserving migrations.
- **Validation:** Run the smallest relevant command, such as API tests for route helpers, web build for client/UI changes, or smoke checks for route constants.

## API Gateway Helpers

### 1. Route wrapper for async errors and schema validation

Current route files manually repeat this shape:

- parse body with `Schema.safeParse(req.body ?? {})`
- return `400 invalid_request`
- extract bearer token when required
- call service in `try/catch`
- map known errors to a response

A small wrapper would make route handlers easier to scan and harder to accidentally make inconsistent.

Possible shape:

```ts
type RouteContext<TBody = unknown, TQuery = unknown> = {
  req: Request;
  res: Response;
  body: TBody;
  query: TQuery;
  accessToken?: string;
};

export function route<TBody>(options: {
  bodySchema?: ZodSchema<TBody>;
  requireAuth?: boolean;
  onError?: (res: Response, error: unknown) => Response;
  handler: (ctx: RouteContext<TBody>) => Promise<Response | void>;
}): RequestHandler;
```

Good first targets:

- `apps/api/src/routes/setup.ts`
- `apps/api/src/routes/work-items.ts`
- `apps/api/src/routes/stored-agents.ts`
- `apps/api/src/routes/proxy.ts`

Keep this wrapper small. It should centralize the repetitive mechanics, not hide the actual domain behavior.

### 2. Middleware for bearer token and workspace ID

`requestAccessToken` and `requestWorkspaceId` are useful, but route handlers still repeat the response behavior. Add helpers that fail with a normalized response:

```ts
export function requireAccessToken(req: Request): string;
export function requireWorkspaceId(req: Request): string;
```

These can throw an `ApiRouteError` that the route wrapper maps to `errorPayload(...)`.

### 3. Shared API route errors

`SetupRouteError` is currently setup-specific, but the pattern is generally useful. Promote the idea into a generic API error:

```ts
export class ApiRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
```

Then service-level errors can be intentionally mapped, while unexpected errors still become `502` with useful details.

## Web API Client Consolidation

Several web API modules duplicate response parsing and error handling:

- `apps/web/src/api/setup.ts`
- `apps/web/src/api/worker-bridge.ts`
- `apps/web/src/api/credentials.ts`
- `apps/web/src/api/broker.ts`
- `apps/web/src/api/runtime-agents.ts`

Create a single helper:

```ts
export class ApiClientError extends Error {
  status: number;
  code?: string;
  details?: unknown;
}

export async function apiFetch<T>(path: string, options: {
  method?: string;
  body?: unknown;
  schema?: { parse(value: unknown): T };
  auth?: "none" | "supabase";
  baseUrl?: string;
}): Promise<T>;
```

Expected benefits:

- One implementation for JSON/text parsing.
- One normalized client error type.
- Schema parsing happens at the call site without repeating boilerplate.
- Authorization headers are opt-in and consistent.
- `resolveBrokerBase()` is applied in exactly one place.

Example after refactor:

```ts
export function fetchSetup(agentId: string): Promise<SetupResponse> {
  return apiFetch(ROUTES.setupByAgent(agentId), {
    method: "GET",
    auth: "supabase",
    schema: SetupResponseSchema,
  });
}
```

## Shared Domain Helpers

### Agent and model helpers

The following logic appears on both sides of the app:

- `asRecord(value)`
- `extractPrimaryModel(modelSettings)`
- `deriveProvider(model)`

Move these into a shared contract helper and add small unit tests. That keeps model display, stored-agent projection, and API-side agent creation aligned.

Candidate module:

```txt
contracts/agent-helpers.ts
```

Potential exports:

```ts
export function asRecord(value: unknown): Record<string, unknown> | null;
export function extractPrimaryModel(modelSettings: unknown): string | null;
export function deriveProviderFromModel(model: string | null): string | null;
```

### Credential provider metadata

Credential logic would benefit from one provider registry:

```ts
export const CREDENTIAL_PROVIDERS = {
  openai: {
    envVar: "OPENAI_API_KEY",
    aliases: ["OPENAI_API_KEY", "openai_api_key", "api_key"],
    launchableKind: "codex",
    label: "OpenAI API key",
  },
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    aliases: ["ANTHROPIC_API_KEY", "anthropic_api_key"],
    launchableKind: null,
    label: "Anthropic API key",
  },
} as const;
```

Then the API can reuse one source of truth for:

- detecting provider
- finding inline secrets
- producing masked labels
- mapping provider to env var
- deciding whether a credential can launch a worker

This directly simplifies `apps/api/src/supabase.ts`, `apps/api/src/services/setup.ts`, and `apps/api/src/routes/stored-agents.ts`.

## Supabase Access Layer

The existing `apps/api/src/supabase-rest-client.ts` is a strong base. The next step is to prevent every service from knowing raw projection strings and PostgREST filter syntax.

Recommended pattern:

```txt
apps/api/src/repositories/
  agents.ts
  credentials.ts
  workspaces.ts
  gateway-config.ts
  engine-instances.ts
  work-items.ts
```

Each repository should expose domain-focused functions:

```ts
export async function findAgentById(accessToken: string, agentId: string): Promise<AgentRow | null>;
export async function listAgentCredentials(agentId: string, workspaceId: string): Promise<CredentialRow[]>;
export async function ensureOwnerWorkspaceMembership(input: ...): Promise<void>;
```

Use the typed Supabase client from `apps/api/src/supabase-client.ts` directly
inside repository or service boundaries. Do not reintroduce low-level
PostgREST wrapper helpers or string-built filters; prefer
`.from(...).select(...).eq(...)`, `.in(...)`, `.insert(...)`,
`.update(...)`, `.upsert(...)`, and `.delete(...)`.

## Stored Agent Activation

`apps/api/src/routes/stored-agents.ts` has two launch paths that do similar work:

- launch a specific credential
- activate an agent by finding the first launchable credential

Extract the repeated sequence:

1. Load agent or credential candidates.
2. Pick launchable credential.
3. Resolve secret.
4. Validate OpenAI credential.
5. Require/provide `cwd`.
6. Create worker bridge session.
7. Return `StoredCredentialActivationResponseSchema` payload.

Candidate service:

```txt
apps/api/src/services/stored-agent-activation.ts
```

Possible function:

```ts
export async function activateStoredAgentCredential(input: {
  launcherClient: LauncherClient;
  agentId: string;
  workspaceId: string;
  cwd: string;
  credentialId?: string;
  model?: string | null;
  validationFailureMode: "response" | "route_error";
}): Promise<StoredCredentialActivationResponse>;
```

This will reduce route file size and make credential launch behavior easier to test without Express.

## React Hooks and UI Reuse

### Async resource hook

Common pattern:

- `const [loading, setLoading] = useState(...)`
- `const [error, setError] = useState<string | null>(null)`
- `load = useCallback(async () => { setLoading(true); setError(null); try ... finally ... })`
- call `load()` in an effect

Candidate hook:

```ts
export function useAsyncResource<T>(loader: () => Promise<T>, deps: DependencyList, options?: {
  initialLoading?: boolean;
  onError?: (error: unknown) => void;
}): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};
```

Good first targets:

- `apps/web/src/hooks/useAgents.ts`
- `apps/web/src/hooks/useSessions.ts`
- settings sections with refresh buttons
- dashboard route loading

For hooks with race protection, such as `useAgentDashboard`, keep the sequence/cancellation behavior or build it into a separate `useLatestAsyncTask`.

### Realtime subscription helper

`useAgentDashboard` manually builds several Supabase channels and cleans them up. A helper could standardize subscription naming, refresh debouncing, and cleanup.

Candidate:

```ts
export function useSupabaseRealtimeRefresh(subscriptions: RealtimeSubscriptionSpec[], onRefresh: () => void): void;
```

This becomes more valuable as more screens subscribe to database changes.

### UI primitives

The web app already has `Button`, `Badge`, `Card`, `Input`, and `Select`. Add a few low-level primitives for repeated states:

- `ErrorCallout`
- `EmptyState`
- `SectionHeader`
- `KeyValueList`
- `MetricTile`
- `DataTable`
- `StatusBadge`

These should stay unopinionated. Settings-specific shells can live under `components/settings/`, while generic pieces should live under `components/ui/`.

## Shared Routes and Contracts

`apps/web/src/api/routes.ts` is already a useful single source for the web client. The API still registers literal path strings. Move HTTP route constants into `contracts/routes.ts` so these consumers share them:

- API route registration
- web API clients
- integration tests
- smoke tests
- docs that mention endpoint paths

Suggested approach:

```ts
export const API_ROUTES = {
  setup: "/api/setup",
  setupByAgent: (agentId: string) => `/api/setup?agentId=${encodeURIComponent(agentId)}`,
  storedAgents: "/api/stored-agents",
  storedAgentCredentials: (agentId: string) => `/api/stored-agents/${encodeURIComponent(agentId)}/credentials`,
  // ...
} as const;
```

Do this incrementally. Start with routes used by both API and web, then migrate tests.

## Tooling and Validation

### Monorepo validation script

The root package currently has `dev`, `logs`, and Supabase schema sync. Add a root validation script that runs the relevant package checks in order:

```json
{
  "scripts": {
    "validate": "pnpm -C apps/api run validate && pnpm -C apps/web run build"
  }
}
```

This gives contributors a single command before opening a PR.

### Smoke tests for route contracts

The implementation checklist already calls out smoke checks. Make them executable and keep the expected paths in shared route constants.

Candidate:

```txt
scripts/smoke-api.sh
```

Checks:

- `GET /health`
- `GET /api/agents`
- `GET /api/setup?agentId=...`
- `GET /api/stored-agents`
- `GET /api/worker-bridge/sessions`

### ADR follow-through

The repo already uses decision records. For each larger helper extraction, add or update a short ADR when it changes ownership boundaries. Useful candidates:

- shared web API client
- route wrapper and API error type
- credential provider registry
- repository layer for Supabase access

## Suggested Implementation Order

Use the PR-sized roadmap above as the source of truth. The broad order is:

1. Build the shared web and API primitives first: PR 1 and PR 2.
2. Move duplicated domain logic into shared helpers: PR 3 and PR 4.
3. Refactor the highest-duplication server workflow: PR 5.
4. Move recurring Supabase query clusters into repositories: PR 6.
5. Clean up repeated React hook and UI patterns: PR 7 and PR 8.
6. Share route contracts and add validation tooling: PR 9 and PR 10.
7. Add broader request observability once the helper boundaries are settled: PR 11.

## Things to Avoid

- Do not introduce a large framework-style abstraction around Express routing. The API is small enough that explicit route handlers are still valuable.
- Do not move API-only secrets or server-only helpers into `contracts/`.
- Do not force every Supabase query through a generic repository abstraction. Domain helpers should improve readability, not hide simple queries.
- Do not refactor all settings UI at once. Extract primitives as repeated patterns become obvious.
- Do not make shared route constants depend on Express or React types. Contracts should remain runtime-light and portable.

## Quick Wins

- Add `ApiClientError` and `apiFetch` for the web client.
- Add `StatusBadge` and shared status variant mapping.
- Move agent model/provider helpers into a shared module.
- Extract `activateStoredAgentCredential` from `stored-agents.ts`.
- Add `pnpm run validate` at the root.

These are small enough to land independently and should reduce the most visible duplication quickly.
