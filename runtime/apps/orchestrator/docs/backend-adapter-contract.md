# Backend Adapter Contract

This document defines the backend abstraction that sits between Symphony's
transport-agnostic orchestration logic and any concrete execution transport.

It refines the existing `Runner`/provider direction into a more explicit model:

- orchestration remains Symphony-owned
- backend adapters own transport-specific run execution
- all backend events are normalized before they reach orchestrator logic

## Why this exists

The repo already separates:

- launcher-side lifecycle/process control via `worker-bridge`
- runtime/frontend transport via `/ws`
- orchestration/state ownership inside Symphony

What was still missing was a single internal contract for:

- starting a run
- streaming events
- interrupt/cancel behavior
- capability checks
- backend-specific admin operations

Without that contract, every new backend risks leaking transport semantics into
orchestrator code.

## Architectural split

### Symphony-owned lifecycle

These remain transport-agnostic and stay in Symphony:

- workspace preparation
- prompt/task construction
- run bookkeeping
- retries and failure categorization
- orchestrator event ingestion
- dashboards, logs, and status surfaces

### Backend-owned transport behavior

These vary by backend and are handled by adapters:

- how a run starts
- how a run is addressed remotely
- how events are streamed back
- how input is sent after startup
- how interrupt/cancel works
- whether agent/session/config operations are supported

The target architecture is:

```text
Orchestrator -> Backend Adapter -> Transport
```

not:

```text
Orchestrator -> subprocess protocol special case
```

## Backend kinds

Recommended initial backend kinds:

- `stdio`
- `openclaw_ws`
- `openclaw_http_sse`
- `http_poll`
- `queue_worker`

Implementation order:

1. `stdio`
2. `openclaw_ws`
3. `openclaw_http_sse`
4. `http_poll`
5. `queue_worker`

Only the first three should be in near-term scope.

## Worker target model

This is the conceptual shape Symphony should resolve before choosing a backend.

```typescript
type WorkerBackend =
  | "stdio"
  | "openclaw_ws"
  | "openclaw_http_sse"
  | "http_poll"
  | "queue_worker";

interface WorkerTarget {
  id: string;
  backend: WorkerBackend;
  url?: string;
  command?: string;
  auth?: {
    type: "bearer" | "trusted_proxy" | "none" | "custom";
    tokenEnv?: string;
    headers?: Record<string, string>;
  };
  routing?: {
    agentId?: string;
    model?: string;
    sessionStrategy?: "create_per_run" | "reuse";
  };
  capabilities?: {
    streaming: boolean;
    interrupts: boolean;
    tools: boolean;
    configOps: boolean;
    agentOps: boolean;
    sessionOps: boolean;
  };
}
```

In this repo, this will likely be represented as Elixir config and `WORKFLOW.md`
schema rather than literal TypeScript interfaces.

## Adapter contract

Recommended internal adapter shape:

```typescript
interface BackendRunHandle {
  runId: string;
  stream(): AsyncIterable<BackendEvent>;
  send?(input: BackendInput): Promise<void>;
  interrupt?(): Promise<void>;
  cancel(): Promise<void>;
  awaitResult(): Promise<BackendResult>;
}

interface BackendAdapter {
  validateTarget(target: WorkerTarget): Promise<void>;
  startRun(args: StartRunArgs): Promise<BackendRunHandle>;
  supports(capability: keyof WorkerTarget["capabilities"]): boolean;

  createAgent?(args: CreateAgentArgs): Promise<AgentRef>;
  updateAgent?(args: UpdateAgentArgs): Promise<void>;
  createSession?(args: CreateSessionArgs): Promise<SessionRef>;
  patchConfig?(args: PatchConfigArgs): Promise<void>;
}
```

Elixir implementation does not need to mirror this syntax exactly, but it should
preserve the same responsibilities:

- validate target config
- start a run
- stream normalized events
- cancel/interrupt where supported
- advertise capability support

## Normalized event model

This is the key decision.

All backend-specific transport events should be normalized into one internal
event stream before orchestration consumes them.

```typescript
type BackendEvent =
  | { type: "run.started"; runId: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed"; text: string }
  | { type: "tool.started"; name: string; callId?: string }
  | { type: "tool.completed"; name: string; output?: unknown; callId?: string }
  | { type: "status"; phase: "queued" | "running" | "waiting" | "done" }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; retryable?: boolean }
  | { type: "run.completed"; output?: unknown; usage?: unknown }
  | { type: "run.failed"; error: string }
  | { type: "run.cancelled" };
```

Symphony should use normalized events for:

- orchestrator state transitions
- retry/failure policy
- logging
- dashboards
- issue status APIs

Bad pattern:

- orchestrator knows OpenClaw WebSocket event names
- orchestrator knows SSE chunk semantics
- orchestrator knows provider-specific cancellation formats

Preferred pattern:

- orchestrator sees normalized events only

## Mapping to existing repo surfaces

### `worker-bridge`

`worker-bridge` remains the launcher-side control plane for worker lifecycle.

It should not become a second browser chat transport.

It may eventually launch or prepare a backend target, but it should not force
orchestrator internals to know whether the underlying execution path is:

- local stdio
- SSH
- OpenClaw WebSocket
- OpenClaw SSE

### runtime `/ws`

runtime `/ws` remains the frontend-facing live transport.

It should consume normalized session/run state from Symphony and should not be
forced to expose raw backend protocol details upward.

### `Runner`

The existing `Runner` direction in this repo should evolve into the backend
adapter abstraction described here.

That means:

- the current Codex subprocess path becomes the `stdio` adapter
- OpenClaw becomes at least two adapters:
  - `openclaw_ws`
  - `openclaw_http_sse`

## OpenClaw-specific guidance

### `openclaw_ws`

Use for:

- full live event stream
- interrupt/steering support
- agent/session/config operations
- the richest control-plane integration

This should be the preferred OpenClaw backend when a stable WS gateway is
available.

### `openclaw_http_sse`

Use for:

- simpler request/response integration
- environments where WebSocket is inconvenient
- streaming responses without session-control depth

This is a valid backend, but it should expose fewer capabilities than
`openclaw_ws`.

### `/tools/invoke`

Treat direct tool invoke as a supporting control surface, not as the primary
worker backend contract.

## Capability-aware scheduling

Scheduler/routing logic should place work based on normalized capabilities, not
backend names.

Examples:

- choose only targets with `streaming: true` for interactive runs
- require `interrupts: true` for operator-steered sessions
- require `agentOps: true` for flows that create/update remote agent resources

## Config direction

Recommended conceptual config shape:

```yaml
workers:
  - id: local-codex
    backend: stdio
    command: codex app-server

  - id: devbox-1
    backend: openclaw_ws
    url: wss://devbox-1.tailnet.ts.net/gateway
    auth:
      type: bearer
      tokenEnv: OPENCLAW_TOKEN_DEVBOX_1
    routing:
      agentId: research
      sessionStrategy: create_per_run

  - id: devbox-2
    backend: openclaw_http_sse
    url: https://devbox-2.tailnet.ts.net
    auth:
      type: bearer
      tokenEnv: OPENCLAW_TOKEN_DEVBOX_2
    routing:
      model: openclaw/default
      sessionStrategy: create_per_run
```

The repo can encode this via `WORKFLOW.md`, runtime config schema, or both.

## Recommended next implementation steps

1. Extract the current Codex subprocess path behind the backend adapter
   abstraction.
2. Keep that path as the default `stdio` backend.
3. Introduce the normalized backend event schema.
4. Add `openclaw_ws`.
5. Add `openclaw_http_sse`.
6. Only later add `http_poll` and `queue_worker`.
