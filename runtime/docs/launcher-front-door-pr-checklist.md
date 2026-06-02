# Launcher Front Door PR Checklist

This is the narrow plan for getting Launcher mode to a stable, testable end-to-end shape without mixing in older migration work.

## Recommendation

This should be **2 additional implementation PRs**, not "several" unrelated PRs.

Counting the two draft PRs that are already open, the clean split is:

- `PR0-runtime`: already open, local schema and launcher writeback alignment
- `PR0-platform`: already open, platform schema/status alignment
- `PR1-runtime-front-door`: add launcher-fronted runtime HTTP and websocket surface
- `PR2-platform-front-door`: point platform proxying at launcher-fronted routes

Only create a separate `PR3-hardening` if the E2E fallout is larger than expected.

## Why this split

- The runtime repo owns the new contract.
- The platform repo mostly consumes that contract.
- Trying to mix both into one PR would make review and rollback worse.
- Splitting runtime further than this would create artificial dependencies and block parallel work.

## PR1: Runtime front door

Goal: the launcher exposes one stable surface per agent, and the platform no longer needs to dial `host:port` directly.

### Contract

- [ ] Define stable launcher-owned paths for agent-scoped runtime traffic
- [ ] Keep the direct per-agent `:4000+` port as an implementation/debug detail
- [ ] Decide the exact path shape and keep it consistent across HTTP and websocket routes
- [ ] Mark an agent as ready only when the front-door target is actually usable

### HTTP proxying

- [ ] Add launcher route(s) for agent-scoped health
- [ ] Add launcher route(s) for agent-scoped `/api/v1/*`
- [ ] Forward method, path, query string, headers, and JSON body correctly
- [ ] Map upstream failures into stable launcher error responses

### Websocket proxying

- [ ] Add launcher-owned agent-scoped websocket upgrade route
- [ ] Proxy auth headers / bearer token through correctly
- [ ] Preserve close codes and useful failure reasons
- [ ] Handle startup race: retriable response while runtime is still becoming ready

### Readiness and state

- [ ] Centralize "runtime ready" checks inside launcher mode
- [ ] Avoid reporting `healthy` before the runtime API is reachable through the front door
- [ ] Keep `engine_instance` for metadata and observability, not as the platform routing contract

### Tests

- [ ] Add runtime tests for front-door HTTP proxying
- [ ] Add runtime tests for websocket proxying or handshake behavior
- [ ] Add runtime tests for readiness / startup race behavior

### Likely files

- [ ] `apps/orchestrator/lib/symphony_elixir/launcher/router.ex`
- [ ] `apps/orchestrator/lib/symphony_elixir/launcher/server.ex`
- [ ] new launcher proxy module(s)
- [ ] launcher tests under `apps/orchestrator/test/...`

## PR2: Platform front door consumer

Goal: the platform API targets the launcher front door rather than resolving `engine_instance.host:port`.

### Runtime target resolution

- [ ] Replace direct runtime target resolution with launcher-front-door resolution
- [ ] Stop constructing browser/API routing URLs from `engine_instance.host:port`
- [ ] Keep `agent_id` resolution behavior unchanged

### HTTP proxy routes

- [ ] Update `/api/agents/*` proxying to call launcher front-door paths
- [ ] Update scoped `/health` checks to call launcher front-door health
- [ ] Keep launcher lifecycle routes like `/api/agents/:id/start` unchanged

### Websocket proxy

- [ ] Update websocket upstream target to the launcher front door
- [ ] Preserve current auth/query handling from the platform side
- [ ] Keep retry behavior only where it still makes sense

### Tests

- [ ] Update integration tests to mock the new launcher-front-door contract
- [ ] Add coverage for scoped health, `/api/agents/:id`, and websocket connect
- [ ] Re-run local login -> setup -> start agent -> chat smoke test

### Likely files

- [ ] `apps/api/src/services/runtime-target.ts`
- [ ] `apps/api/src/routes/proxy.ts`
- [ ] `apps/api/src/routes/health.ts`
- [ ] `apps/api/src/ws/orchestrator-proxy.ts`
- [ ] platform integration / E2E tests

## Optional PR3: Hardening only if needed

Do this only if PR1 or PR2 turns out larger than expected.

- [ ] Runbook updates for the new launcher-front-door contract
- [ ] Status enum cleanup / central mapping helper
- [ ] Extra diagnostics for launcher-front-door failures
- [ ] Additional end-to-end smoke coverage

## Parallelization guidance

Recommended order:

1. Land the existing schema-alignment PRs first or keep them stacked as the base.
2. Start `PR1-runtime-front-door`.
3. Once the runtime path shape is stable, run `PR2-platform-front-door` in parallel against that contract.

Safe parallel work:

- One agent on runtime front-door HTTP/WS route design and implementation
- One agent on platform proxy retargeting once the runtime path names are fixed
- One agent on tests/runbook cleanup only after the contract is stable

Avoid parallelizing:

- Multiple agents editing the same runtime launcher router/proxy modules
- Platform work before the runtime path contract is written down
