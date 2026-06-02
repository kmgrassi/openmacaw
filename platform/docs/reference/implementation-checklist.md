# Parallel Agent Platform — Implementation Checklist

This checklist is for incremental delivery. Mark items as complete as you move through implementation.

## Scope assumptions (explicit ownership)

- **This repository (`parallel-agent-platform`) owns the API gateway + Web client**
  - API gateway (Node/Express) on port `:3100`.
  - Web client (React) on port `:5173`.
  - Route contract and cross-layer compatibility from client ↔ gateway.

- **Other repository (Launcher repo) owns orchestrator provisioning + lifecycle**
  - Launcher process management API on `:4100` (`/orchestrators`).
  - Orchestrator process startup/ownership/recovery.

- **API setup/control responsibilities in this repository**
  - Must call launcher control plane (in the launcher repo) to map users to orchestrators.
  - Must preserve auth/session context and route client requests to the assigned orchestrator port.

---

## Phase 1 — Baseline API contract alignment (this repo)

- [ ] Ensure `GET /health` and `/api/v1/health` map to orchestrator `GET /api/v1/health`.
- [ ] Ensure `GET /api/agents` maps to orchestrator `GET /api/v1/state`.
- [ ] Ensure `POST /api/agents` maps to orchestrator `POST /api/v1/agents`.
- [ ] Ensure `PATCH /api/agents/:id` maps to orchestrator `PATCH /api/v1/:id`.
- [ ] Ensure `DELETE /api/agents/:id` maps to orchestrator `DELETE /api/v1/:id`.
- [ ] Ensure `GET /api/agents/:id/messages` maps to `GET /api/v1/:id/messages`.
- [ ] Ensure `POST /api/agents/refresh` maps to `POST /api/v1/refresh`.
- [ ] Ensure websocket path `/ws` is proxied through to active orchestrator.
- [ ] Add explicit request/response contract comments for each route (short mapping note in code).
- [ ] Update `apps/api/README.md` to reflect exact broker contract.

## Phase 2 — Web client/API-facing stability

- [ ] Define shared route constants only once (already in `apps/web/src/api/routes.ts`).
- [ ] Remove hard dependency on `/api/v1/*` paths in client code.
- [ ] Keep login flow resilient when broker endpoints are temporarily unavailable:
  - [ ] authenticated users still get dashboard route,
  - [ ] non-blocking warning message only.
- [ ] Verify auth bootstrap handles `broker_unavailable`/`orchestrator_unreachable` gracefully.
- [ ] Confirm dashboard renders when no orchestrator is yet started.
- [ ] Ensure onboarding route is not required for dashboard-first path.

## Phase 3 — Cross-repo contract validation

- [ ] Create/confirm API-side contract list in API repo mirrors this contract exactly.
- [ ] Add a small `curl`/smoke test script in this repo to validate mappings:
  - [ ] `/health`
  - [ ] `/api/agents`
  - [ ] `/api/agents/:id`
  - [ ] `/api/agents/:id/messages`
  - [ ] `/api/agents/refresh`
- [ ] Add same smoke test in API repo and web repo to verify end-to-end request paths.

## Phase 4 — Runtime/provisioning integration (launcher repo + API control layer)

- [ ] Launcher exposes `/orchestrators` contract:
  - [ ] `POST /orchestrators`
  - [ ] `GET /orchestrators`
  - [ ] `GET /orchestrators/:id`
  - [ ] `DELETE /orchestrators/:id`
- [ ] API persists and resolves `{ user_id -> orchestrator_id, port }`.
- [ ] API updates mappings on setup/config changes.
- [ ] API switches user dashboard context to newly provisioned orchestrator.
- [ ] Add orchestrator restart/recovery validation for port changes.

## Phase 5 — Operational hardening

- [ ] Add structured errors for missing orchestrator route mapping (404 vs 502 cases).
- [ ] Add logs indicating resolved orchestrator target URL/path per request.
- [ ] Add alerting/visibility for `orchestrator_unreachable` spikes.
- [ ] Add docs for expected env vars and startup ordering:
  - [ ] Launcher
  - [ ] API
  - [ ] Web

## Acceptance checklist (minimum viable)

- [ ] User can sign in and land on dashboard.
- [ ] Dashboard lists agents without 404/502 from `/api/agents`.
- [ ] Chat messages can be sent/received over websocket.
- [ ] Re-run smoke checks after each piecemeal change.
