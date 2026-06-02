# Backend Adapter Rollout Plan

This document turns the backend-adapter architecture into a concrete refactor
plan for this repo.

It is intentionally scoped as mergeable PR slices rather than one large
migration. Each PR should preserve current behavior unless the checklist for
that PR explicitly says otherwise.

Read this together with:

- `backend-adapter-contract.md`
- `model-agnostic-lift-plan.md`
- `remote-worker-openclaw.md`
- `runtime_websocket_gateway_contract.md`

## Rollout goals

- Keep Symphony orchestration intact.
- Preserve the current Codex subprocess path as the default `stdio` backend.
- Introduce backend adapters without breaking `worker-bridge` or runtime `/ws`.
- Normalize backend events before they hit orchestrator state transitions.
- Add OpenClaw as additive backends only after the `stdio` path is stable behind
  the new abstraction.
- Reuse the existing Supabase persistence model where it already covers runs,
  tasks, and sessions.

## Non-goals for the first rollout

- Do not redesign scheduler semantics.
- Do not change browser-facing `/ws` contract in the first backend PRs.
- Do not add `http_poll` or `queue_worker` yet.
- Do not collapse `worker-bridge` and runtime `/ws` into one transport.
- Do not create new run/session tables unless the existing schema proves
  insufficient during the adapter refactor.

## Existing persistence to reuse

Before adding any schema, the refactor should map onto the current tables:

- `broker_run`
  - canonical run-attempt record
- `broker_task`
  - leased execution-task record
- `session_thread`
  - durable session/thread record
- `message`
  - persisted run/session message output and metadata
- `openclaw_agent_session_index`
  - OpenClaw session reuse/index table

The main schema question left open is whether we need a generic normalized
backend-event history beyond what `broker_task.last_event` and `message`
already provide.

## PR sequence

### PR 1: Freeze current behavior with contract tests

Branch: `codex/backend-rollout-pr1-contract-tests`

Goal: lock down the current stdio/Codex behavior before introducing a new
adapter seam.

Primary ownership:

- `apps/orchestrator/test/symphony_elixir_web/gateway_socket_test.exs`
- `apps/orchestrator/test/symphony_elixir/*`
- any test helpers needed to pin current runner events and lifecycle

Checklist:

- [ ] Add tests that pin current `chat.send` happy-path behavior
- [ ] Add tests that pin current `chat.abort` behavior
- [ ] Add tests that pin current failure/timeout mapping from the current runner path
- [ ] Add tests that pin the minimum event sequence the orchestrator/runtime expects
- [ ] Add tests for any currently implied Codex-specific assumptions that will be moved behind the adapter seam

Definition of done:

- [ ] The current path is covered well enough that a runner extraction can be judged as behavior-preserving
- [ ] No production code behavior changes are required in this PR

### PR 2: Introduce the backend behavior and target resolution seam

Branch: `codex/backend-rollout-pr2-runner-behavior`

Depends on: PR 1

Goal: create the new internal seam without changing the default runtime path.

Primary ownership:

- `apps/orchestrator/lib/symphony_elixir/agent_runner.ex`
- `apps/orchestrator/lib/symphony_elixir/config.ex`
- `apps/orchestrator/lib/symphony_elixir/config/schema.ex`
- `apps/orchestrator/lib/symphony_elixir/workflow.ex`

Checklist:

- [ ] Introduce `SymphonyElixir.Runner` behavior or equivalent backend contract module
- [ ] Introduce backend target resolution for the current default path
- [ ] Keep the default resolved backend as the existing Codex subprocess path
- [ ] Add config/schema support for backend-aware target selection without requiring OpenClaw config yet
- [ ] Keep all call sites behavior-compatible with the current stdio path
- [ ] Document which existing tables (`broker_run`, `broker_task`, `session_thread`) the seam will reuse

Definition of done:

- [ ] Orchestrator/runner call sites no longer depend directly on subprocess-specific internals
- [ ] Existing deployments still default to the current Codex behavior with no config changes

### PR 3: Move Codex subprocess execution behind the `stdio` adapter

Branch: `codex/backend-rollout-pr3-stdio-adapter`

Depends on: PR 2

Goal: make the current path an explicit `stdio` backend adapter.

Primary ownership:

- `apps/orchestrator/lib/symphony_elixir/codex/app_server.ex`
- `apps/orchestrator/lib/symphony_elixir/codex/dynamic_tool.ex`
- new `apps/orchestrator/lib/symphony_elixir/runner/codex.ex` or equivalent
- `apps/orchestrator/lib/symphony_elixir/agent_runner.ex`

Checklist:

- [ ] Wrap the existing Codex app-server/subprocess path behind the backend contract
- [ ] Expose run start/stream/cancel through the adapter instead of direct subprocess assumptions
- [ ] Keep tool wiring unchanged for the stdio backend
- [ ] Keep retry and error behavior unchanged
- [ ] Add adapter-level tests for the stdio backend

Definition of done:

- [ ] The current runtime path is implemented through the new adapter layer
- [ ] No orchestrator branch should need to know that stdio is backed by Codex app-server details

### PR 4: Introduce normalized backend events

Branch: `codex/backend-rollout-pr4-normalized-events`

Depends on: PR 3

Goal: ensure orchestrator logic sees one backend-neutral event model.

Primary ownership:

- `apps/orchestrator/lib/symphony_elixir/orchestrator.ex`
- `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex`
- new event normalization module(s)
- status/dashboard presenters if needed

Checklist:

- [ ] Define the internal normalized backend event schema
- [ ] Map stdio/Codex adapter events into normalized backend events
- [ ] Update orchestrator state transitions to consume normalized fields only
- [ ] Update gateway/runtime translation to read normalized events, not raw transport-specific ones
- [ ] Preserve the existing browser-facing `/ws` contract
- [ ] Decide whether normalized backend-event persistence can reuse `message` and `broker_task.last_event` or needs a dedicated table

Definition of done:

- [ ] No transport-specific event names leak into orchestrator state transitions
- [ ] The browser-facing socket remains backward compatible

### PR 5: Capability flags and worker-target config

Branch: `codex/backend-rollout-pr5-capabilities`

Depends on: PR 4

Goal: make backend capabilities first-class in config and runtime selection.

Primary ownership:

- `apps/orchestrator/lib/symphony_elixir/config/schema.ex`
- `apps/orchestrator/lib/symphony_elixir/config.ex`
- `apps/orchestrator/lib/symphony_elixir/runner/selection.ex`
- `apps/orchestrator/WORKFLOW.md` examples and docs

Checklist:

- [ ] Add capability fields for streaming, interrupts, tools, config ops, agent ops, and session ops
- [ ] Add backend target config shape to workflow/runtime config
- [ ] Update selection logic so it can choose a backend target by capability and policy
- [ ] Keep default behavior identical when only one stdio target exists
- [ ] Add tests for target selection fallback

Definition of done:

- [ ] Backend placement decisions can be made by capability metadata rather than hardcoded backend names

### PR 6: OpenClaw WebSocket backend

Branch: `codex/backend-rollout-pr6-openclaw-ws`

Depends on: PR 5

Goal: add the richest OpenClaw backend first.

Primary ownership:

- new `apps/orchestrator/lib/symphony_elixir/runner/openclaw_ws.ex`
- runner selection/config wiring
- OpenClaw adapter tests

Checklist:

- [ ] Implement target validation for `openclaw_ws`
- [ ] Implement run startup and event streaming over the OpenClaw gateway WebSocket
- [ ] Map OpenClaw WS events into normalized backend events
- [ ] Implement cancel/interrupt where supported
- [ ] Advertise capability support for agent/session/config ops
- [ ] Add health/ping support for target availability checks
- [ ] Reuse `openclaw_agent_session_index` for remote session reuse/mapping where possible

Definition of done:

- [ ] A workflow can route to an OpenClaw WebSocket target without changing orchestration logic
- [ ] OpenClaw WS errors map into existing retry/failure categories

### PR 7: OpenClaw HTTP/SSE backend

Branch: `codex/backend-rollout-pr7-openclaw-sse`

Depends on: PR 5

Goal: add a lower-complexity OpenClaw fallback backend.

Primary ownership:

- new `apps/orchestrator/lib/symphony_elixir/runner/openclaw_sse.ex`
- runner selection/config wiring
- SSE adapter tests

Checklist:

- [ ] Implement target validation for `openclaw_http_sse`
- [ ] Implement streaming request execution over HTTP/SSE
- [ ] Map SSE chunks/events into normalized backend events
- [ ] Explicitly advertise the reduced capability set versus `openclaw_ws`
- [ ] Add health/ping support for availability checks

Definition of done:

- [ ] OpenClaw SSE can be selected as a backend target
- [ ] Its lower capability surface is explicit in config and selection logic

### PR 8: `worker-bridge` integration with backend targets

Branch: `codex/backend-rollout-pr8-worker-bridge`

Depends on: PR 5

Goal: let launcher-side worker lifecycle prepare backend-targeted sessions
without becoming a second chat transport.

Primary ownership:

- `apps/orchestrator/lib/symphony_elixir/worker_bridge/server.ex`
- `apps/orchestrator/lib/symphony_elixir/launcher/router.ex`
- `apps/orchestrator/docs/worker-bridge.md`

Checklist:

- [ ] Extend worker-bridge request/response metadata to reference backend targets where appropriate
- [ ] Keep worker-bridge focused on lifecycle/control plane only
- [ ] Avoid exposing raw backend event streams through worker-bridge
- [ ] Preserve existing local `kind: codex` path as a valid default

Definition of done:

- [ ] Worker lifecycle and backend execution targets can be connected cleanly without duplicating frontend transport concerns

### PR 9: Runtime `/ws` cleanup against normalized backend events

Branch: `codex/backend-rollout-pr9-runtime-ws`

Depends on: PR 4

Goal: align runtime WebSocket internals with the new normalized backend event model
while keeping the external socket contract stable.

Primary ownership:

- `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex`
- `apps/orchestrator/docs/runtime_websocket_gateway_contract.md`
- socket tests

Checklist:

- [ ] Ensure runtime `/ws` methods translate into backend-targeted runs cleanly
- [ ] Ensure runtime event emission is driven from normalized backend events
- [ ] Keep `connect`, `chat.send`, and `chat.abort` contract-compatible
- [ ] Update shipped-contract docs only where internal implementation changes must be clarified

Definition of done:

- [ ] Frontend-visible socket behavior stays stable while backend execution becomes pluggable

## Merge strategy

Recommended merge order:

1. PR 1
2. PR 2
3. PR 3
4. PR 4
5. PR 5
6. PR 6 and PR 7 can proceed in parallel after PR 5
7. PR 8 and PR 9 can proceed in parallel after their dependencies land

## High-level checkpoint list

- [ ] PR 1 landed: current behavior frozen with tests
- [ ] PR 2 landed: backend seam introduced
- [ ] PR 3 landed: stdio adapter in place
- [ ] PR 4 landed: normalized backend events in place
- [ ] PR 5 landed: capability-aware target selection in place
- [ ] PR 6 landed: OpenClaw WebSocket backend added
- [ ] PR 7 landed: OpenClaw HTTP/SSE backend added
- [ ] PR 8 landed: worker-bridge aligned with backend targets
- [ ] PR 9 landed: runtime `/ws` aligned with normalized backend events

## Notes for implementation owners

- If a PR touches orchestrator state transitions, it must preserve retry semantics.
- If a PR touches runtime `/ws`, it must preserve the shipped browser-facing contract unless the PR is explicitly documented as a contract change.
- If a PR touches worker-bridge, it must preserve the control-plane versus live-transport split.
- OpenClaw support is additive. The stdio backend should remain the rollback path until staging proves the remote backends.
- Schema additions should be treated as a last step after proving existing
  tables cannot represent the needed backend-neutral state.
