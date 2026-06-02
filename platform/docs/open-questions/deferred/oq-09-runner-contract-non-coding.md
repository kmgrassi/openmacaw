# OQ-09: Runner contract for non-coding verticals

> Open question #9 from [docs/product-vision.md](../product-vision.md):
>
> "Runner contract for non-coding verticals. Today's `Runner`
> behavior is shaped by Codex and OpenClaw — `start_session`,
> `run_turn`, `stop_session`, `ping`. Does the same shape work for a
> video render (asynchronous, possibly hours-long, GPU-bound) or a
> browser-automation task (interactive, possibly multi-step within
> one 'turn')? May need a longer-running / streaming variant of the
> contract. Don't generalize prematurely — but worth designing once
> we have a second non-trivial runner."

## What we know

- The current behavior (see
  [runner-abstraction.md](../runner-abstraction.md)) was designed
  around chat-shaped agents:
  ```elixir
  @callback start_session(opts) :: {:ok, session} | {:error, term}
  @callback run_turn(session, input) :: {:ok, output} | {:error, term}
  @callback stop_session(session) :: :ok
  @callback ping(session) :: :ok | {:error, term}
  ```
- This shape assumes:
  1. There's a *session* — durable, lives across turns.
  2. Turns are *short* (seconds to minutes).
  3. Each turn is request → response.
- Real non-coding work breaks at least one of those assumptions:
  - A video render is hours-long, not turn-shaped at all.
  - A long browser-automation run might intermix LLM "thinking"
    with deterministic steps inside a single logical "turn."
  - A bulk transcription job might not have a "session" — it's
    one-shot fan-out.

## Two emerging runner shapes

Looking at real runners we plausibly want to support, two distinct
runtime shapes emerge:

### Shape A: synchronous-conversational (today's contract)

- Codex, ChatGPT, Claude Code, OpenAI computer-use.
- Lifecycle: start → many short turns → stop.
- Right primitive: `start_session` + `run_turn`.

### Shape B: asynchronous-job

- Video render, batch transcription, "go run this overnight"
  research.
- Lifecycle: submit → poll for status → fetch result.
- Right primitive: `submit_task` + `poll_task` + `cancel_task`.

These don't unify cleanly at the Elixir behavior level. Trying to
force the async shape into `run_turn` ends in a 6-hour-long
synchronous call that breaks every reconnection assumption in the
worker-bridge.

## Recommendation

Introduce a **runtime-shape declaration** on the runner module and
**two parallel behaviors** the orchestrator dispatches against.

```elixir
defmodule Runner.Behaviour do
  @callback runtime_shape() :: :sync | :async
end

defmodule Runner.Sync do
  @behaviour Runner.Behaviour
  @callback start_session(opts) :: {:ok, session} | {:error, term}
  @callback run_turn(session, input) :: {:ok, event} | {:error, term}
  @callback resume(session, snapshot, human_response) ::
    {:ok, event} | {:error, term}    # see OQ-08
  @callback stop_session(session) :: :ok
  @callback ping(session) :: :ok | {:error, term}
end

defmodule Runner.Async do
  @behaviour Runner.Behaviour
  @callback submit_task(opts) :: {:ok, task_handle} | {:error, term}
  @callback poll_task(task_handle) ::
    {:running, progress_pct, message} |
    {:done, result} |
    {:failed, reason} |
    {:needs_human, escalation_payload}
  @callback cancel_task(task_handle) :: :ok
end
```

The orchestrator's dispatcher checks `runtime_shape/0` and uses the
right behavior contract. From the rest of the system's perspective
(work_item rows, escalation, gates), nothing changes — both shapes
emit the same set of canonical events.

### Don't ship `Runner.Async` until we need it

Empty contracts rot. We should:

1. Keep today's `Runner.Sync` contract.
2. Land the `runtime_shape/0` callback now (defaulting to `:sync`)
   so existing runners declare their shape explicitly. Cheap.
3. Land `Runner.Async` only when we have a *real* async runner
   ready (the most likely first one is a video-render runner; the
   second might be a long-running research/data-collection
   runner).

This gives us the seam without speculative code.

## Streaming inside Shape A

Browser-automation might not need Shape B — it might just need
**event streams within a single `run_turn`**. Today `run_turn`
returns one `event`. Extend it to return a stream:

```elixir
@callback run_turn(session, input) :: Enumerable.t(event) | {:error, term}
```

Where `event` is a tagged tuple — `{:partial_output, …}`,
`{:tool_call, …}`, `{:final, …}`, `{:question_for_human, …}`. The
`Enumerable` lets the worker-bridge forward each event to the
orchestrator as it arrives.

This is a strictly additive change to the sync contract.

## Mapping the four real runners

| Runner            | Shape | Notes                                              |
|-------------------|-------|----------------------------------------------------|
| `Codex`           | sync  | already conversational; works as-is                |
| `OpenClaw`        | sync  | already conversational; works as-is                |
| `ComputerUse`     | sync (streaming) | needs the streaming `run_turn`           |
| `OpenAICompatible`| sync  | conversational                                     |
| `DaVinci` / `Premiere` | async | long-running render jobs                       |
| `BrowserBatch`    | async | overnight scrapes / form fills                     |

## Concrete next step

- [ ] Add `runtime_shape/0` to `Runner.Behaviour`. Default = `:sync`.
      Update existing runners to declare it. (one PR in
      `parallel-agent-runtime`)
- [ ] Make `run_turn/2` return an `Enumerable.t(event)` (allowing a
      single-element list for backward compat). Update worker-bridge
      to consume an iterator. (one PR)
- [ ] Define `Runner.Async` behavior in code, but **don't**
      implement it for any real runner yet — wait for the first
      async use case. (one PR — interface only, with tests against
      a `Runner.Async.Mock`)
- [ ] When the first async runner lands, write the orchestrator
      dispatcher branch. (deferred)

## Open sub-questions

- Do we need a third shape — **stream of inputs** (e.g., a runner
  that consumes a Kafka topic or a tail-of-log)? Recommendation:
  no, model that as periodic `submit_task` calls in async shape.
- How does a sync runner with a streaming turn interact with
  resume ([OQ-08](./oq-08-re-entry-semantics.md))? Recommendation:
  the snapshot includes the last emitted event index; resume
  re-establishes the stream from that index where supported,
  otherwise replays.
