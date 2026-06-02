# Runtime WebSocket Gateway Contract

This document defines the current runtime-side WebSocket contract implemented in PR #23.

Scope:
- `parallel-agent-platform` web client and API server teams need a stable reference for the runtime socket behavior.
- `parallel-agent-runtime` exposes the runtime-side `/ws` endpoint and chat/session methods described here.

This is intentionally a shipped-contract document, not a future-state design doc. Anything not implemented yet is called out explicitly in `Current gaps`.

## Worker-bridge vs `/ws`

These are separate responsibilities and should not be treated as competing chat transports.

- `worker-bridge` is the launcher-side lifecycle/process API:
  - start a worker-backed session
  - list running sessions
  - inspect or stop a launched session
- runtime `/ws` is the live transport API:
  - connect a client to a runtime session
  - send `chat.send` / `chat.abort`
  - receive streaming `chat` events and session updates

The intended cross-repo model is:

1. the platform control plane may use `worker-bridge` to create or prepare the backing worker/runtime session
2. the platform resolves the runtime scope for that launched session
3. the web client connects to runtime `/ws` for actual live interaction

That means the platform should not introduce a second chat transport on top of `worker-bridge`.
`worker-bridge` is process/session lifecycle; `/ws` is the frontend-facing realtime transport.

## Endpoint

- Path: `GET /ws`
- Host: the runtime/orchestrator HTTP server
- Transport: raw WebSocket
- Protocol: plain JSON frames

This is not a Phoenix Channel transport. The client should send and receive JSON frame envelopes directly.

## Connection scope

The runtime expects these query params on the websocket URL:

- `agent_id`
- `workspace_id`
- `user_id`
- `session_key`

Example:

```text
ws://localhost:4000/ws?agent_id=<uuid>&workspace_id=<uuid>&user_id=<uuid>&session_key=<user_id>:<workspace_id>:<agent_id>
```

The runtime uses these values as the connection scope and validates chat requests against them. `user_id` is required and must be supplied by the platform after it validates the browser's Supabase JWT. The runtime does not accept or verify JWTs.

## Frame model

### Request

```json
{
  "type": "req",
  "id": "8d95d4dc-bfd1-4cb6-9730-c7a6e4ceba63",
  "method": "chat.send",
  "params": {}
}
```

### Response

```json
{
  "type": "res",
  "id": "8d95d4dc-bfd1-4cb6-9730-c7a6e4ceba63",
  "ok": true,
  "payload": {}
}
```

Error responses use:

```json
{
  "type": "res",
  "id": "8d95d4dc-bfd1-4cb6-9730-c7a6e4ceba63",
  "ok": false,
  "error": {
    "code": "runtime_scope_required",
    "message": "runtime scope required"
  }
}
```

### Event

```json
{
  "type": "event",
  "event": "chat",
  "payload": {}
}
```

### Hello

After a successful `connect`, the runtime sends a `hello-ok` frame:

```json
{
  "type": "hello-ok",
  "protocol": 3,
  "server": {
    "version": "0.1.0",
    "connId": "5cb7f6be-b23f-4e2d-89f3-4d1fb6dc6e40"
  },
  "features": {
    "methods": [
      "channels.status",
      "chat.abort",
      "chat.send",
      "config.get",
      "config.set",
      "connect",
      "models.list",
      "sessions.delete",
      "sessions.list",
      "sessions.reset",
      "sessions.usage",
      "usage.cost",
      "web.login.start",
      "web.login.wait"
    ],
    "events": [
      "chat",
      "connect.challenge"
    ]
  },
  "snapshot": {},
  "auth": {
    "role": "operator",
    "scopes": ["operator.admin", "operator.approvals", "operator.pairing"]
  },
  "policy": {
    "tickIntervalMs": 30000
  }
}
```

## Implemented methods

The runtime currently accepts these methods:

- `connect`
- `chat.send`
- `chat.abort`
- `models.list`
- `sessions.list`
- `sessions.reset`
- `sessions.delete`
- `config.get`
- `config.set`
- `channels.status`
- `sessions.usage`
- `usage.cost`
- `web.login.start`
- `web.login.wait`

## Method behavior

### `connect`

Purpose:
- mark the socket as connected
- ensure an in-memory session exists for the connection scope
- return the `hello-ok` capability frame

Current behavior:
- rejects the connection request with `runtime_scope_required` when any required scope param, including `user_id`, is missing
- no JWT verification; the platform owns auth and forwards only the verified `user_id`
- no challenge-response flow is enforced on the runtime side yet

### `chat.send`

Required params:

- `agent_id`
- `workspace_id`
- `user_id` is inherited from the connection scope
- `sessionKey`
- `message`
- `deliver`
- `idempotencyKey`

Example:

```json
{
  "type": "req",
  "id": "1",
  "method": "chat.send",
  "params": {
    "agent_id": "11111111-1111-4111-8111-111111111111",
    "workspace_id": "22222222-2222-4222-8222-222222222222",
    "sessionKey": "agent:11111111-1111-4111-8111-111111111111:main",
    "message": "Fix the failing test",
    "deliver": false,
    "idempotencyKey": "run-123"
  }
}
```

Behavior:
- validates request scope against the connection scope
- loads agent metadata from the runtime’s agent inventory adapter
- appends the user message into the runtime in-memory session
- reserves a single active run for that session
- starts a Codex-backed worker task
- emits `chat` events for streaming and completion

Response payload:

```json
{
  "runId": "run-123",
  "ok": true
}
```

### `chat.abort`

Required params:

- `agent_id`
- `workspace_id`
- `sessionKey`
- optional `runId`

Behavior:
- validates request scope
- kills the active task for the session or targeted run
- emits a best-effort `chat` event with `state: "aborted"`

### `models.list`

Behavior:
- returns model/provider info from the stored agent’s `model_settings` where available
- otherwise falls back to a default synthetic Codex model entry

### `sessions.list`

Behavior:
- returns the in-memory runtime session list
- sorted by most recently updated
- supports `limit`

### `sessions.reset`

Behavior:
- clears message history and token counters for the given session key

### `sessions.delete`

Behavior:
- deletes the session from the in-memory store
- clears active runs for that session
- kills any attached task before deletion

### `config.get`

Behavior:
- returns the current `WORKFLOW.md` snapshot
- includes:
  - `raw`
  - `hash`
  - parsed `config`
  - `source`

### `config.set`

Required params:

- `raw`
- optional `baseHash`

Behavior:
- expects `raw` to be a JSON object string
- rewrites the YAML front matter in `WORKFLOW.md`
- preserves the current prompt body
- rejects stale writes when `baseHash` does not match current file content

### Placeholder methods

These methods exist but currently return placeholder or in-memory-only data:

- `channels.status`
- `sessions.usage`
- `usage.cost`
- `web.login.start`
- `web.login.wait`

## `chat` event model

The runtime emits `event: "chat"` frames.

### `delta`

```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "run-123",
    "sessionKey": "agent:11111111-1111-4111-8111-111111111111:main",
    "state": "delta",
    "message": "streaming text..."
  }
}
```

### `final`

```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "run-123",
    "sessionKey": "agent:11111111-1111-4111-8111-111111111111:main",
    "state": "final",
    "message": {
      "role": "assistant",
      "content": "final assistant text"
    }
  }
}
```

### `error`

```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "run-123",
    "sessionKey": "agent:11111111-1111-4111-8111-111111111111:main",
    "state": "error",
    "errorMessage": "agent_not_found",
    "errorCode": "agent_not_found"
  }
}
```

### `aborted`

```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "run-123",
    "sessionKey": "agent:11111111-1111-4111-8111-111111111111:main",
    "state": "aborted"
  }
}
```

## Runtime session model

The current runtime keeps session state in memory only.

Stored fields include:
- `key`
- `id`
- `agent_id`
- `workspace_id`
- `user_id`
- `kind`
- `label`
- `display_name`
- `surface`
- `updated_at`
- `model`
- `messages`
- `input_tokens`
- `output_tokens`
- `total_tokens`

Important implications:
- sessions disappear on runtime restart
- `sessions.list` is process-local state
- usage data is not durable analytics

## Run lifecycle guarantees

The current implementation now guarantees:

- a run is reserved in the session store before the worker task is allowed to begin
- only one active run may exist per session
- abnormal task exits remove stale runs
- normal task exits do not race away the run before final completion is emitted
- deleting a session while a run is active does not crash the session store

These fixes were added while addressing PR review comments on the initial websocket slice.

## API server responsibilities

The API server should treat the runtime as the websocket backend and continue acting as the proxy layer.

Expected responsibilities on the API side:
- accept browser websocket connections on its own `/ws`
- resolve the correct runtime instance/port
- proxy websocket frames through to runtime `/ws`
- forward scope query params:
  - `agent_id`
  - `workspace_id`
  - `user_id`
  - `session_key`
- continue owning auth, token handling, and policy decisions; JWTs must not be forwarded to runtime `/ws`

This runtime PR does not replace the API server websocket bridge.

Where `worker-bridge` exists in the flow:

- the API server may call launcher `POST /worker-bridge/sessions` before any websocket traffic starts
- the API server is responsible for mapping the resulting launched session into the runtime scope that `/ws` expects
- the browser should still talk only to the API server websocket entrypoint, not to `worker-bridge`

## Client responsibilities

The web client can keep using the existing gateway client pattern:

1. resolve runtime scope via REST
2. open `/ws` with scoped query params
3. send `connect`
4. send `chat.send` / `chat.abort`
5. consume `chat` events

The client should still treat websocket failures as runtime-layer failures, not inventory failures.

## Local smoke client

This repo includes a minimal websocket smoke client:

```bash
pnpm run debug:orchestrator:ws
```

Useful variants:

```bash
pnpm run debug:orchestrator:ws --method models.list
pnpm run debug:orchestrator:ws --method config.get
pnpm run debug:orchestrator:ws --message "Fix the failing test"
```

The helper script lives at:

- [runtime-ws-client.mjs](../../../scripts/runtime-ws-client.mjs)

It is intended as a contract reference and local verification tool for the
platform client, not as production frontend code.

## Current gaps

These are not implemented by PR #23:

- REST chat history endpoint compatible with `GET /api/agents/:id/messages`
- durable session transcripts
- durable usage/cost analytics
- real channel status integrations
- real web login flow
- device signature verification / websocket auth enforcement
- runtime-side `connect.challenge` behavior

The biggest integration gap for the current frontend is the missing REST history reload path after a `final` event.

## Source files

Runtime implementation:

- [gateway_controller.ex](../lib/symphony_elixir_web/controllers/gateway_controller.ex)
- [gateway_socket.ex](../lib/symphony_elixir_web/gateway_socket.ex)
- [session_store.ex](../lib/symphony_elixir/gateway/session_store.ex)
- [chat_runner.ex](../lib/symphony_elixir/gateway/chat_runner.ex)
- [config_snapshot.ex](../lib/symphony_elixir/gateway/config_snapshot.ex)

Tests:

- [gateway_socket_test.exs](../test/symphony_elixir_web/gateway_socket_test.exs)
