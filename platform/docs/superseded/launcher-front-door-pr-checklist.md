# Launcher Front Door PR Checklist

This is the platform-local checklist for the remaining launcher integration work.

The broader migration docs in this repo are still useful background, but they are too wide for the blocker we have right now. The blocker is narrower: the platform needs a stable launcher-fronted runtime contract.

## Recommendation

Treat the remaining work as **2 more implementation PRs across 2 repos**:

- runtime repo: `PR1-runtime-front-door`
- platform repo: `PR2-platform-front-door`

The two draft PRs already open remain the base alignment work:

- runtime PR #51
- platform PR #38

## Scope for this repo

This repo should not invent a second runtime-discovery model. Once the launcher exposes stable agent-scoped HTTP and websocket routes, this repo should consume those routes directly.

## PR2: Platform front door consumer

Goal: API and web traffic keep going through the platform, but the platform forwards runtime traffic to launcher-owned agent-scoped routes instead of `engine_instance.host:port`.

### Runtime target changes

- [ ] Replace direct runtime-target host/port resolution with launcher-front-door path resolution
- [ ] Stop using `engine_instance` as the client-facing routing contract
- [ ] Keep `engine_instance` use limited to metadata/diagnostics if still needed

### HTTP routes

- [ ] Update `/api/agents/*` proxy path mapping to target launcher-owned agent routes
- [ ] Update `/health` and `/api/v1/health` scoped checks to use launcher-owned agent health
- [ ] Leave launcher lifecycle calls like `/api/agents/:id/start` alone

### Websocket routes

- [ ] Update `/ws` proxying to connect to launcher-owned agent websocket routes
- [ ] Preserve bearer token and cookie forwarding
- [ ] Preserve current agent scoping rules

### Error handling

- [ ] Normalize "runtime not ready" vs "runtime unreachable" errors against the new launcher contract
- [ ] Remove retry logic that only existed to rediscover raw runtime ports
- [ ] Keep user-facing errors stable where possible

### Tests

- [ ] Update integration tests for `/api/agents/:id`
- [ ] Update integration tests for scoped `/health`
- [ ] Update websocket proxy tests for launcher-front-door upstreams
- [ ] Re-run local login -> setup -> agent start -> chat smoke test

### Likely files

- [ ] `apps/api/src/services/runtime-target.ts`
- [ ] `apps/api/src/routes/proxy.ts`
- [ ] `apps/api/src/routes/health.ts`
- [ ] `apps/api/src/ws/orchestrator-proxy.ts`
- [ ] `apps/api/src/launcher-proxy.integration.test.ts`

## Cross-repo dependency

This PR depends on the runtime repo defining the front-door path contract first. Once those path names are fixed, the platform work should move quickly.

## Optional follow-up

Only split a third PR if the implementation lands quickly and the remaining work is just cleanup:

- [ ] runbook updates
- [ ] extra diagnostics
- [ ] additional E2E coverage
