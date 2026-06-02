# Architecture

## System Overview

Symphony Express Server is a **thin HTTP gateway** that sits between clients and the Symphony orchestration API (an Elixir/Phoenix application).

```
┌──────────┐       ┌───────────────────────┐       ┌──────────────────────┐
│  Client   │──────▶│  Symphony Express     │──────▶│  Orchestrator        │
│  (browser,│◀──────│  Server (:3100)       │◀──────│  (Elixir API :4000)  │
│   CLI)    │       └───────────────────────┘       └──────────────────────┘
└──────────┘
```

## Responsibilities

**This server does:**
- Expose stable REST endpoints for clients
- Proxy requests to the orchestrator with timeout protection
- Normalize error responses into a consistent JSON shape
- Report aggregate health (self + upstream)

**This server does NOT:**
- Hold business logic — that lives in the orchestrator
- Manage state — it is stateless
- Authenticate users (future — see Roadmap below)

## Request Flow

1. Client sends HTTP request to an `/api/v1/*` endpoint.
2. Express route handler calls `orchestratorRequest(path, init)`.
3. `orchestratorRequest` sends the request to `ORCHESTRATOR_BASE_URL + path` with an `AbortController` timeout.
4. Response is parsed as JSON or text based on `content-type`.
5. Route handler returns `{ status, body }` to the client.
6. On failure: `handleProxyError` returns 504 (timeout) or 502 (unreachable).

## Error Shape

All errors follow this structure:

```json
{
  "error": {
    "code": "orchestrator_timeout",
    "message": "Orchestrator request timed out",
    "details": null
  }
}
```

Produced by `errorPayload(code, message, details?)`.

## Endpoints

| Method | Path | Type | Description |
|--------|------|------|-------------|
| GET | `/health` | Custom | Server + upstream health |
| GET | `/api/v1/health` | Proxy | Orchestrator health |
| GET | `/api/v1/state` | Proxy | Orchestrator state |
| POST | `/api/v1/refresh` | Proxy | Trigger orchestrator refresh |
| GET | `/api/v1/issues/:id` | Proxy | Lookup issue by identifier |

## Key Design Decisions

1. **Single-file server**: At this scale, one file is simpler than premature module splitting. Split when the file exceeds ~500 lines or when distinct domains emerge (e.g., auth middleware, separate route groups).

2. **Native `fetch`**: Uses Node.js built-in fetch (available since Node 18). No `axios` or `node-fetch` dependency needed.

3. **AbortController for timeouts**: Standard pattern that works with native fetch. The timeout is configurable via `ORCHESTRATOR_REQUEST_TIMEOUT_MS`.

4. **ES Modules**: The project uses `"type": "module"` and `NodeNext` module resolution. All imports must use ESM syntax.

5. **Typed Supabase database access**: New API database calls must use `getServiceRoleSupabase()` from `src/supabase-client.ts` and Supabase query-builder methods such as `.from(...).select(...)`, `.insert(...)`, and `.update(...)`. The legacy `supabase-rest-client.ts` wrapper remains only for existing call sites until the typed-client migration is complete.

## Roadmap (Future Considerations)

- **Auth middleware**: JWT or API key validation before proxying.
- **Rate limiting**: Per-client rate limits at the gateway level.
- **Request logging**: Structured request/response logging middleware.
- **Route splitting**: Move route groups into separate files as the API surface grows.
- **Circuit breaker**: Protect against cascading failures from the orchestrator.
