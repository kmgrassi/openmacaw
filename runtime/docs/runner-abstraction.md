# Runner Abstraction Scope

## Goal

Replace the Codex-shaped execution path with a runner contract that can support any large language model backend.

The current runtime already has a `Runner` behavior, but several concrete paths are still Codex-specific:
- `Runner.Codex` wraps the Codex app-server process.
- `Codex.AppServer` speaks Codex JSON-RPC and Codex tool events directly.
- `starter.ex` derives Codex command lines from model settings.
- Gateway chat assumes the active agent session is backed by the Codex app-server lifecycle.

This scope defines the interface and migration path before code changes.

## Problem

The runtime can already store messages in the database, but the execution layer is still tied to one backend family.

That creates three constraints:
- model changes are hard to apply dynamically
- non-Codex backends need a separate path later
- the runtime surface is harder to reason about because execution, transport, and model selection are coupled

## What The Runner Must Cover

A runner must support the same operational lifecycle that Codex currently covers:
- create a session
- execute one turn
- stream progress/events
- handle tool calls
- handle approvals or rejection prompts
- stop and clean up the session
- report backend readiness
- tell the orchestrator whether it needs a workspace

## Proposed Contract

Keep the existing `SymphonyElixir.Runner` behavior as the public abstraction, but make it backend-neutral.

```elixir
@callback start_session(config :: map(), workspace :: String.t() | nil)
          :: {:ok, session :: map()} | {:error, term()}

@callback run_turn(session :: map(), prompt :: String.t(), work_item :: WorkItem.t())
          :: {:ok, result :: map()} | {:error, term()}

@callback stop_session(session :: map())
          :: :ok | {:error, term()}

@callback ping(config :: map())
          :: :ok | {:error, term()}

@callback requires_workspace?() :: boolean()
```

The important constraint is not the method names. It is that the data shape returned by each runner is normalized:
- session metadata is backend-neutral
- turn results are normalized to success / retryable error / fatal error
- streamed events are converted into a stable event vocabulary before they reach the dashboard or persistence layer

`SymphonyElixir.Runner.Contract` is the executable contract for these shapes. The behavior remains intentionally small; the contract module defines what each callback result means to runner consumers.

## Normalized Session Semantics

`start_session/2` returns `{:ok, session}` where `session` is an adapter-owned map. Callers may keep passing that original map back to the same runner, but code outside the adapter should depend only on this normalized view:

```elixir
%{
  runner: "codex" | "planner" | "openclaw" | "computer_use" | String.t(),
  session_id: String.t(),
  provider: String.t(),
  model: String.t(),
  workspace: String.t() | nil,
  metadata: map(),
  backend: map()
}
```

Only `:runner` is always required in the normalized view. Other fields are present when the backend can provide them. `:backend` preserves the original adapter session for diagnostics and adapter re-entry, but orchestrator routing and UI state should not branch on backend-only keys such as Codex ports, thread IDs, JSON-RPC IDs, remote action IDs, or HTTP client state.

Session identity means the active backend execution session. It is separate from persisted chat history and can change if a model switch restarts the backend session.

## Normalized Result Semantics

`run_turn/3` returns exactly one of these outcome classes:

```elixir
{:ok, %{status: :completed, output_text: String.t(), usage: map(), backend: map()}}
{:error, %{status: :retryable_error, reason: term()}}
{:error, %{status: :fatal_error, reason: term()}}
```

Adapter callbacks may still return the existing tuple forms for compatibility:

```elixir
{:ok, result_map}
{:error, {:retryable, reason}}
{:error, {:fatal, reason}}
{:error, reason}
```

`Runner.Contract.normalize_result/1` maps those forms into the normalized result vocabulary. The orchestrator retry policy should treat `:retryable_error` as safe to retry and `:fatal_error` as terminal for that run. An unclassified `{:error, reason}` is fatal by default so new adapters must opt into retries explicitly.

## Normalized Event Semantics

Runners stream progress by calling `on_message.(event_map)` when the session includes an `:on_message` function. Every event must map to this stable vocabulary before it reaches dashboard or persistence consumers:

```elixir
:session_started
:turn_started
:notification
:tool_call_started
:tool_call_completed
:tool_call_failed
:unsupported_tool_call
:approval_requested
:approval_resolved
:turn_completed
:turn_ended_with_error
:startup_failed
```

Normalized event maps use atom keys:

```elixir
%{
  event: :notification,
  timestamp: DateTime.t(),
  payload: map(),
  message: String.t(),
  usage: map(),
  metadata: map()
}
```

Only `:event` and `:timestamp` are required. Backend-native event names, JSON-RPC methods, or remote transport payloads may remain in `:payload` for compatibility and diagnostics, but consumers should branch on the normalized `:event` value.

## What Should Be Generic

These concepts should live in the runner abstraction, not in the Codex adapter:
- session lifecycle
- turn execution
- streaming event dispatch
- model/provider selection
- workspace requirement checks
- transport health checks
- retry classification
- state reporting for the dashboard

## What Can Stay Backend-Specific

These pieces can remain inside the backend adapter:
- process spawning vs HTTP vs WebSocket transport
- backend auth
- backend-specific tool serialization
- model name normalization for that backend
- backend-specific rate-limit or quota metadata
- backend-specific approval protocol mapping

## Codex-Specific Logic To Remove Or Wrap

The current Codex path should be treated as an implementation detail behind the new abstraction:
- `Codex.AppServer`
- the Codex JSON-RPC message grammar
- the Codex `thread/start` and `turn/start` payload building
- Codex tool call event mapping
- Codex command derivation from `model_settings.primary`

The goal is not to delete Codex support. The goal is to make it one runner implementation among several.

## Codex Behavior Required By The Contract

The Codex adapter must keep these behaviors while hiding their protocol details behind `Runner.Codex`:

- validate and use a workspace before starting a local or SSH app-server process
- launch the configured Codex command and keep the process handle adapter-owned
- initialize the app-server protocol, create a thread, and start turns in that thread
- preserve the active thread/session across continuation turns
- map Codex JSON-RPC notifications to the stable runner event vocabulary
- surface assistant text deltas as `:notification` events
- surface tool execution as `:tool_call_completed`, `:tool_call_failed`, or `:unsupported_tool_call`
- handle approval or user-input requests non-interactively when policy requires it
- report `:turn_completed`, `:turn_ended_with_error`, and `:startup_failed` with enough metadata for dashboard and broker logging
- return retryable or fatal errors using the runner result semantics instead of leaking raw process/protocol failures to the orchestrator
- stop the app-server process when the session ends

These are contract obligations because the orchestrator, dashboard, broker log, continuation logic, and workspace lifecycle already rely on them. The JSON-RPC method names, payload building, port management, and Codex-specific tool serialization are not public contract details.

## Migration Plan

### Phase 1: Freeze the contract

- Keep the `Runner` behavior as the stable boundary.
- Define normalized session/result/event semantics in docs and tests.
- Identify the pieces of Codex behavior that are required by the contract.

### Phase 2: Extract Codex behind the boundary

- Move Codex-only logic into `Runner.Codex` and helper modules.
- Remove direct Codex assumptions from `AgentRunner` and gateway orchestration code.
- Keep behavior unchanged for the existing Codex path.

### Phase 3: Add a backend-neutral model selection path

- Let the runtime select a model/provider from agent config or per-turn config.
- Treat `agent.model_settings.primary` as an input to runner configuration, not as a Codex-only setting.
- Allow the backend adapter to map that selection onto its own model syntax.

### Phase 4: Add a second runner implementation

- Add one non-Codex runner as proof that the interface is actually generic.
- Use the same session/turn/event contract.
- Keep the orchestrator and UI unchanged except for runner selection and diagnostics.

## Model Switching Implication

Once this abstraction exists, switching an agent's model becomes a runner configuration problem instead of a Codex command problem.

That means the runtime can choose between:
- changing the model for the next session
- restarting the active session with a new model
- applying a per-turn override, if the backend supports it

The interface should support all three, even if the first implementation only uses the first two.

## Session Meaning

In this scope, "session" means the active execution session:
- the live WebSocket connection to the runtime
- the current runner/backend process or remote session
- the model and provider currently being used for turns

It does not mean the persisted chat transcript or the database-backed message history. Those should remain intact across a model switch.

## Desired UX

If the current model becomes unusable during an active session, the frontend should surface a model-switch prompt.

The prompt should appear for failures such as:
- rate limits
- backend errors
- timeouts
- model unavailability
- other conditions that make the active model unusable for the current run

When the user selects a different model, the runtime should restart the active session with the new model and continue from the existing conversation state where possible.

## Non-Goals For This Phase

- rewriting message persistence
- rewriting the dashboard
- adding a new model marketplace
- implementing every possible LLM backend at once
- changing the user-facing agent data model beyond what is needed to drive runner selection

## Acceptance Criteria

- The runtime can describe a runner without mentioning Codex in the public contract.
- Codex still works through the new abstraction with no behavior regression.
- A second backend can be added without changing the orchestrator dispatch loop.
- Model selection can be passed through the abstraction instead of being hardcoded to Codex config.

## Open Questions

- Should a runner expose explicit capabilities, or should capabilities stay in backend-specific config?
- Should per-turn model overrides be supported in the first cut, or deferred until a backend proves it is safe?
