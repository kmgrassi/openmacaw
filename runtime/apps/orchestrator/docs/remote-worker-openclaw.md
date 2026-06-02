# Remote Worker Chain and OpenClaw Integration Plan

Goal: allow Symphony to dispatch to multiple kinds of workers, including SSH hosts and remote OpenClaw
instances, with explicit health checks and deterministic retries.

This document complements `backend-adapter-contract.md` and focuses on how
OpenClaw should fit into the backend model for this repo.

## Current state

- `worker.ssh_hosts` is already supported.
- Remote execution is currently via SSH command transport, using the same Codex command runner remotely.
- Workspace hooks are executed on local or SSH host, and worker metadata includes `worker_host`.
- There is no explicit remote ping/health-check contract yet.

## What is missing

- A universal worker interface that distinguishes:
  - **Execution worker** (where to run turns).
  - **Orchestration worker** (where orchestration state is held; still Symphony).
- A chain model where openclaw can be a step in execution path (e.g., orchestrator -> OpenClaw gateway -> Codex worker host).
- Active remote worker health checks beyond SSH command fallback.
- A clear split between OpenClaw WebSocket and OpenClaw HTTP/SSE transport modes.

## Recommended worker abstraction

Introduce a pluggable worker adapter contract:

- `type`: `local`, `ssh`, `openclaw_ws`, `openclaw_http_sse`, `openclaw_relay`
- `ping/1`: health check endpoint or command.
- `workspace_path/2`: resolve workspace for issue on that worker.
- `launch_session/2`: start one run attempt.
- `run_turn/3`, `stop/1`, `cancel/1`.

State should retain:

- `worker_id` (host name, URL, or ECS task id),
- `worker_type` (`local|ssh|openclaw`),
- `worker_caps` (max_concurrent, supported providers, capabilities),
- `last_ping_ms`, `last_ping_result`.

## Remote ping design

### SSH worker ping

- Use SSH no-op as heartbeat:
  - `printf '{"worker_host":"%s","ok":true,"ts":"%s"}\n'`
- Collect latency and return status in orchestrator telemetry.

### OpenClaw worker ping

- Health endpoint contract:
  - `GET /v1/health`
  - response: `{ "ok": true, "version": "x", "ready": true }`
- Optional queue endpoint check:
  - `GET /v1/queues/capacity`
- Mark worker unusable if ping fails or returns non-2xx.

## OpenClaw backends

### `openclaw_ws`

Use this backend when Symphony needs:

- full live event streaming
- interrupt/steering support
- remote agent/session/config operations
- the richest remote control plane

This is the preferred OpenClaw backend when the gateway WebSocket surface is
available and stable.

### `openclaw_http_sse`

Use this backend when Symphony needs:

- simpler request/response semantics
- incremental streaming over HTTP
- lower session/control-plane complexity

This backend should be treated as a lower-capability alternative to
`openclaw_ws`, not as the same thing with a different wire format.

## OpenClaw as chain member

Use a dedicated worker adapter that accepts an issue task and executes via OpenClaw APIs:

For `openclaw_ws`:

- open gateway connection
- create or select remote agent if needed
- create or reuse session
- send run input over the session transport
- translate gateway events into normalized backend events

For `openclaw_http_sse`:

- start request on streaming HTTP endpoint
- consume SSE stream
- translate SSE events/chunks into normalized backend events
- finalize with normalized completion/failure result

This keeps Symphony in charge of:
- issue selection,
- retries,
- tracker reconciliation,
- workspace ownership,
- state transitions.

## Chain example

1. Symphony claims issue `MT-123`.
2. Worker selection chooses `openclaw` because issue label indicates provider preference.
3. Worker health is verified before dispatch.
4. Workspace is prepped by local/remote helper.
5. OpenClaw backend starts the run and yields a backend run handle.
6. Orchestrator receives normalized backend events.
7. Failures are converted into existing retry policy and delay rules.

## Implementation sequence

1. Add generic worker/backend adapter + ping lifecycle.
2. Implement `openclaw_ws` with auth/env token resolution and normalized event mapping.
3. Implement `openclaw_http_sse` as a lower-capability fallback backend.
4. Extend retry scheduler to record backend-specific backoff penalties.
5. Add API surface to return worker diagnostics (`/api/v1/<issue_identifier>` and state overview).

## Security checkpoints

- Use short-lived tokens (vault/SSM + rotation).
- Restrict OpenClaw to repo workspace roots or approved repository mount paths.
- Validate signed requests or mTLS for internal worker endpoints.
