# Worker-Bridge and Runtime WebSocket Architecture

This note defines the intended separation between launcher-side worker lifecycle
and runtime-side live session transport.

## Core split

- `worker-bridge` is control plane infrastructure.
- runtime `/ws` is frontend-facing realtime transport.

They are related, but they do not serve the same purpose.

## What `worker-bridge` owns

The launcher-side worker bridge is responsible for:

- creating a worker-backed session
- preparing the repository or validating `cwd`
- injecting credentials and env vars
- returning session/process metadata
- listing, inspecting, and stopping launched sessions

That is lifecycle and process management.

It should not become a second frontend chat transport.

## What runtime `/ws` owns

The runtime websocket endpoint is responsible for:

- binding a client connection to runtime scope
- accepting live session methods such as `connect`, `chat.send`, and `chat.abort`
- streaming incremental and final `chat` events back to the client
- exposing runtime session/config methods such as `sessions.list` and `config.get`

That is session transport and interactive control.

## End-to-end relationship

The intended end-to-end flow is:

1. The platform control plane decides that a worker-backed session should exist.
2. The platform may call launcher `POST /worker-bridge/sessions` to prepare or
   start that session.
3. The platform records the runtime scope that the frontend must use:
   - `agent_id`
   - `workspace_id`
   - `session_key`
   - runtime base URL or routed API-server `/ws` entrypoint
4. The frontend opens the websocket connection for that runtime scope.
5. The frontend sends `connect`, then `chat.send` / `chat.abort`.
6. The runtime streams `chat` events for that scoped session.

So the important mapping is not “worker to websocket” directly. The important
mapping is:

- launched worker/session
- runtime scope
- frontend websocket connection

## Platform/API-server responsibility

The platform/API server is the glue layer between these two systems.

It should own:

- auth and policy
- session creation decisions
- any call to launcher `worker-bridge`
- lookup of the correct runtime instance
- translation from launched session metadata into runtime websocket scope
- websocket proxying from browser `/ws` to runtime `/ws`

The browser should not call `worker-bridge` directly.

## Frontend responsibility

The frontend should assume:

- `worker-bridge` is not the browser transport
- runtime `/ws` is the browser transport
- session scope comes from the platform/API layer

The frontend should not need to know how the worker process was launched, only:

- which runtime websocket URL to open
- which scope values to use
- which methods/events the runtime websocket supports

## One transport, not two

We should keep one frontend chat transport:

- browser <-> platform websocket gateway <-> runtime `/ws`

Using `worker-bridge` as a parallel browser chat protocol would duplicate state,
capabilities, and error handling for no real gain.

## Current implementation status

Shipped today in this repo:

- launcher `worker-bridge` HTTP lifecycle API
- runtime `/ws` websocket gateway

Still left to the cross-repo integration layer:

- explicit mapping from launched worker/session metadata to runtime websocket scope
- browser-facing websocket proxy in the platform/API server
- durable session history reload outside the runtime process
