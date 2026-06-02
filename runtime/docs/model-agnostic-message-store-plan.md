# Model-Agnostic Message Store — Runtime Scoping

## Goal

Ensure the runtime orchestrator emits message-level model metadata so the
platform can persist it in a transport-agnostic way. Today the runner contract
(`SymphonyElixir.Runner.Contract`) carries `runner`, `provider`, and `model` on
the **session** struct, but individual **events** (`:turn_completed`,
`:notification`) do not reliably surface this information downstream.

---

## Current Architecture (Elixir orchestrator)

### Runner contract (`lib/symphony_elixir/runner/contract.ex`)

```elixir
@type session :: %{
  required(:runner)   => runner_type(),   # e.g. "codex", "openclaw"
  optional(:provider) => String.t(),      # e.g. "anthropic"
  optional(:model)    => String.t(),      # e.g. "claude-sonnet-4-20250514"
  ...
}

@type event :: %{
  required(:event)     => event_name(),
  required(:timestamp) => DateTime.t(),
  optional(:payload)   => map(),
  optional(:message)   => String.t(),
  optional(:usage)     => map(),
  optional(:metadata)  => map()
}
```

Key observation: the `event` type has an optional `:metadata` map, but no
runner currently populates it with model provenance.

### Runner adapters

Each adapter (`codex.ex`, `openclaw.ex`, `openclaw_ws.ex`, `local_relay.ex`,
`computer_use.ex`, `manager.ex`, `planner.ex`) resolves its own session struct
with `:runner`, `:provider`, `:model`. These values are available at the
adapter level but are **not forwarded into emitted events**. Manager and
planner are active runner types routed by `SymphonyElixir.Runner.resolve/2`,
and both emit persisted `:notification` / `:turn_completed` message events via
`emit_message/3`.

---

## PR Plan

### PR 1 — Emit model metadata in message events

**Branch:** `feat/message-model-metadata`

Enrich runner events that carry message content with the resolved model
metadata so the platform (and any future consumer) can attribute each message
to the model that generated it.

#### Changes

1. **Runner.Contract** — add a helper function `with_model_metadata/2` that
   merges session-level model info into an event's `:metadata` map:

   ```elixir
   @spec with_model_metadata(event(), session()) :: event()
   def with_model_metadata(event, session) do
     model_meta = %{
       model: session[:model],
       provider: session[:provider],
       runner_kind: session[:runner]
     }
     Map.update(event, :metadata, model_meta, &Map.merge(&1, model_meta))
   end
   ```

2. **Each runner adapter** — call `with_model_metadata/2` when emitting
   events that contain message content. The target events are:
   - `:turn_completed` — the primary assistant response
   - `:notification` — streaming deltas (if the consumer persists partials)

   Adapters to update:
   - `codex.ex`
   - `openclaw.ex`
   - `openclaw_ws.ex`
   - `local_relay.ex`
   - `computer_use.ex`
   - `manager.ex`
   - `planner.ex`

3. **Agent runner (`agent_runner.ex`)** — when the orchestrator relays events
   upstream (to the gateway/WebSocket), pass through the `:metadata` map
   unmodified so that the platform layer can read `model`, `provider`, and
   `runner_kind`.

#### Event shape after change

```elixir
%{
  event: :turn_completed,
  timestamp: ~U[2026-04-27 12:00:00Z],
  message: "Here is the answer...",
  usage: %{input_tokens: 1200, output_tokens: 340},
  metadata: %{
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    runner_kind: "openclaw"
  }
}
```

#### Files touched

- `lib/symphony_elixir/runner/contract.ex`
- `lib/symphony_elixir/runner/codex.ex`
- `lib/symphony_elixir/runner/openclaw.ex`
- `lib/symphony_elixir/runner/openclaw_ws.ex`
- `lib/symphony_elixir/runner/local_relay.ex`
- `lib/symphony_elixir/runner/computer_use.ex`
- `lib/symphony_elixir/runner/manager.ex`
- `lib/symphony_elixir/runner/planner.ex`
- `lib/symphony_elixir/agent_runner.ex`

---

### PR 2 — Runner adapters include resolved model info in message events

**Branch:** `feat/runner-resolved-model-info`

For runners that resolve the concrete model at runtime (e.g., the codex adapter
may receive a model alias like `"codex"` and resolve it to
`"codex-mini-latest"`), ensure the **resolved** model name is included in event
metadata, not the alias.

#### Changes

1. In each adapter's session initialization, store the resolved model as
   `:resolved_model` alongside the original `:model` field.
2. `with_model_metadata/2` preferentially uses `:resolved_model` if present,
   falling back to `:model`.
3. Update tests for each adapter to assert that `:turn_completed` events
   contain the expected metadata keys.

#### Files touched

- Same adapter files as PR 1
- `test/symphony_elixir/runner/*_test.exs` (add/update metadata assertions)

---

## How the orchestrator passes metadata through

The call chain is:

```
Runner adapter
  -> emits event with :metadata
  -> AgentRunner receives event callback
  -> forwards to gateway WebSocket as JSON frame
  -> Platform reads metadata.model / metadata.provider / metadata.runner_kind
  -> Platform writes to unified message API
```

The **AgentRunner** (`agent_runner.ex`) already forwards events upstream via
its event callback. The only requirement is that it does **not strip** the
`:metadata` key from events before serializing to JSON. This should be
verified and a test added.

---

## Open Questions

1. **Streaming deltas** — Should `:notification` events (streaming chunks)
   also carry model metadata, or only the final `:turn_completed`? Including
   it on every delta adds payload size. Recommendation: include on
   `:turn_completed` only; the platform can infer the model for deltas from
   the corresponding run's execution profile.
2. **Multi-model turns** — If a manager agent delegates to sub-agents using
   different models within a single turn, each sub-agent's events already
   carry their own session. The parent turn's metadata should reflect the
   parent's model, not the child's.
3. **Backward compatibility** — Consumers that do not expect `:metadata` on
   events should be unaffected since it is an additive, optional field.
