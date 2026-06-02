# Model Provider Swap Plan

Goal: make the worker runtime provider-agnostic while keeping existing Codex behavior as default.

This document should be read together with
`backend-adapter-contract.md`, which defines the target backend contract,
normalized event model, and backend capability shape.

## Current state

- Runtime already supports one runtime command via `codex.command`.
- In practice, this is effectively a **Codex-specific** runner (tool specs, app-server protocol, protocol events).
- You can already change model behavior by passing model flags in `codex.command` (for example `codex app-server --model ...`), but this is still one protocol family.

## Desired state

- Add a backend layer so an issue can run with Codex, OpenClaw, or other transports without changing orchestrator mechanics.
- Keep the orchestrator decision model (dispatch, retries, workspace policy, heartbeat/reconciliation) unchanged.

## Recommended architecture

1. Evolve the current runner idea into a backend adapter behavior:

```elixir
defmodule SymphonyElixir.Runner do
  @callback validate_target(map()) :: :ok | {:error, term()}
  @callback start_run(map()) :: {:ok, map()} | {:error, term()}
  @callback stream_events(map()) :: Enumerable.t()
  @callback cancel_run(map()) :: :ok | {:error, term()}
  @callback interrupt_run(map()) :: :ok | {:error, term()}
  @callback supports?(atom()) :: boolean()
end
```

The exact Elixir callback names can differ, but the architecture should preserve
these responsibilities:

- validate target config
- start a run
- stream normalized events
- cancel and interrupt where supported
- advertise capabilities

2. Backends:

- `SymphonyElixir.Runner.Codex` as the `stdio` backend.
- `SymphonyElixir.Runner.OpenClawWS` for remote OpenClaw WebSocket integration.
- `SymphonyElixir.Runner.OpenClawSSE` for remote OpenClaw HTTP/SSE integration.
- `SymphonyElixir.Runner.Mock` for tests.

3. Extend `WORKFLOW.md` config with backend-aware worker targets:

```yaml
workers:
  - id: local-codex
    backend: stdio
    command: "codex app-server"

  - id: openclaw-primary
    backend: openclaw_ws
    url: "wss://openclaw.mycompany.com/gateway"
    auth:
      type: bearer
      tokenEnv: OPENCLAW_API_KEY
    routing:
      sessionStrategy: create_per_run

  - id: openclaw-sse-fallback
    backend: openclaw_http_sse
    url: "https://openclaw.mycompany.com"
    auth:
      type: bearer
      tokenEnv: OPENCLAW_API_KEY
    routing:
      model: "o4-mini"
```

4. Map worker target and backend capabilities to issue/workload routing:

- Static per-workspace target mapping in workflow.
- Per-issue label-based routing (example: `model:gpt-5`, `backend:openclaw_ws` tags).
- Fallback chain: issue label → issue priority policy → default worker target.

## Open questions to resolve up front

- How should turn-level events from each backend map to one normalized internal event schema?
- Which capability flags should be scheduler-visible in phase 1?
- What are approval semantics for non-Codex providers (auto-approve vs explicit operator input)?

## Rollout steps

1. Introduce normalized internal backend events before they reach orchestrator state transitions.
2. Wrap current Codex module behind the new behavior interface as `stdio`.
3. Add integration test coverage for multiple backend targets with fallback.
4. Backfill config parser + docs + examples.

## Acceptance criteria

- A workflow can switch backend target without restarting the tracker orchestration topology.
- Existing Codex-only deployments continue to run unchanged.
- New backend failures must map to existing orchestrator error/retry categories.
