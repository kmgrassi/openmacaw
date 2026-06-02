# Launcher Architecture and Cross-Repo Integration

This document captures the intended multi-repo orchestration flow and how this repo is expected to connect with the external API server and web client.

## Overview

```text
Three processes, two repos, one user.

Web Client (React)      API Server (Node/Bun)      Launcher (this repo)      Orchestrator runtime(s)
:5173                   :3100                      :4100                     :4000+

VITE_BROKER_BASE ───────────────────────────────────────▶ API

/web socket & /api requests                                   LAUNCHER_BASE_URL
                                                              ───────────────────────────▶ Launcher (:4100)
                                                                     ├─ start/stop orchestrators
                                                                     └─ return port per user run
                                                                    ↓
                                                           Orchestrators (read-only API) :4000+
                                                                     ▲
                                                        API maps request/user state to active orchestrator
```

## What this document says

- The web client communicates only with the API server at `VITE_BROKER_BASE`.
- The API server owns user setup/config persistence and orchestrator lifecycle orchestration.
- The Launcher owns process supervision and process restarts.
- Each orchestrator instance is launched with repo-specific config and exposes read-only HTTP/WS endpoints under `:4000+`.
- API routes are remapped to orchestrator endpoints and websocket upgraded through the API host.

## High-level flow

### New user setup
1. User completes setup in web client.
2. API persists setup in Supabase.
3. API starts/retrieves a launcher orchestrator via `POST /orchestrators`.
4. Launcher returns `{ id, port }`.
5. API stores `{ user_id -> orchestrator_id, port }`.
6. API proxies dashboard routes (`/api/agents*`, `/health`, `/ws`) to that orchestrator.

### Returning user
1. API looks up user orchestrator mapping.
2. If present, API routes traffic directly to the running orchestrator port.

### Config update
1. User updates setup.
2. API replaces orchestrator with `DELETE /orchestrators/:id` + `POST /orchestrators`.
3. API persists new mapping.

### Recovery
1. Launcher persists active orchestrator descriptors.
2. On launcher restart it rebuilds orchestrators.
3. API discovers active ports/status via launcher and keeps routing current.

## Launcher API contract

Base URL: `LAUNCHER_BASE_URL` (default `http://127.0.0.1:4100`)

- `POST /orchestrators` → start an orchestrator
- `GET /orchestrators` → list running
- `GET /orchestrators/:id` → status + port
- `DELETE /orchestrators/:id` → stop

## Proxy mapping from API server

- `GET /api/agents` → orchestrator `GET /api/v1/agents` (state-ish listing)
- `GET /api/agents/:identifier` → orchestrator `GET /api/v1/:identifier`
- `POST /api/agents/refresh` → orchestrator `POST /api/v1/refresh`
- `GET /health` → orchestrator `GET /api/v1/health`
- `WS /ws` → pass-through websocket

## Environment variables

### Launcher

- `LAUNCHER_PORT` (default `4100`)
- `LAUNCHER_STATE_DIR` (default `~/.symphony/launcher`)

### Per-orchestrator env

- `LINEAR_API_KEY`
- `LINEAR_ASSIGNEE`
- `PORT`

### API server

- `LAUNCHER_BASE_URL` (default `http://127.0.0.1:4100`)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`

### Web client

- `VITE_BROKER_BASE` (default `http://127.0.0.1:3100`)

## Known gaps in this repository (as of this implementation)

1. **Launcher APIs are not yet implemented in this repo**
   - The code in this workspace currently includes the API gateway/proxy and web client wiring, but not the full launcher management plane (`/orchestrators`, persistence, and supervisor control endpoints).

2. **API setup/control endpoints are not present here**
   - Endpoints for `/api/setup`, user config writes, and orchestrator ownership lookup are expected on the API side, but are handled outside of this repo’s current code path.

3. **Agent path contract needs strict alignment**
   - API proxy currently exposes `/api/agents*` and translates to orchestrator `/api/v1/` routes, and `/health` is mapped similarly. If launcher/API upstream path conventions drift, the web client can still get `orchestrator_unreachable` or `not_found` at runtime.

4. **Auth/session ownership is client-side in this repo**
   - Current auth flow focuses on local Supabase/session handling in web client + broker handshake. Ownership/permission checks tied to `user_id -> orchestrator_id` are external by contract.

5. **Cross-repo route naming consistency should be versioned**
   - Keep a single source of truth for path contracts (for `/api/v1/...`, health endpoints, ws path, and setup routes) to avoid 404/502 churn between repos.

## Conclusion

The architecture is solid as a systems-level design. The main risk is implementation drift across repos:
- launcher orchestration, 
- API ownership/provisioning endpoints,
- route contracts.

If those contracts are kept in lockstep, the flow is valid and operationally sound.
