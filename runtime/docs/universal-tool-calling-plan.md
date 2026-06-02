# Universal Tool Calling — Runtime Scoping Document

## Overview

This document scopes the runtime (Elixir orchestrator) work required to support universal tool calling across all model providers. The runtime is responsible for translating model-agnostic tool definitions into provider-specific formats, managing the multi-turn tool-calling loop for relay-dispatched agents, and dispatching tool execution requests to the helper daemon via the relay transport.

## Current State

- **`Runner.LocalRelay`** (`lib/symphony_elixir/runner/local_relay.ex`) dispatches work to the helper via the relay WebSocket. It builds dispatch frames with `prompt`, `model`, `provider`, and `work_item` but does not include tool definitions or handle tool-call responses from the model.
- **`Codex.DynamicTool`** (`lib/symphony_elixir/codex/dynamic_tool.ex`) handles tool execution for the Codex runner only. Tools were previously hardcoded but are now seeded in the database (`public.tool` table with `slug`, `parameters` JSON Schema, `execution_kind`, and `runner_kind` columns — see harper-server PR #495).
- **`Codex.ToolPolicy`** (`lib/symphony_elixir/codex/tool_policy.ex`) resolves which dynamic tools are exposed to a Codex session based on agent kind (planning vs coding). It does not apply to relay-dispatched agents.
- **Database schema** — The `tool` table stores definitions (name, slug, description, parameters JSON Schema, execution_kind, runner_kind). The `agent_tool` join table assigns tools to agents. The `tool_call` table records each execution linked to a `message` row. 21 tools are seeded from the existing runtime code.
- **`Runner.Contract`** (`lib/symphony_elixir/runner/contract.ex`) defines the event vocabulary including `:tool_call_started`, `:tool_call_completed`, `:tool_call_failed`, and `:unsupported_tool_call` — the event infrastructure already exists.
- **Protocol frames** exist for `dispatch`, `progress`, `output`, `complete`, and `error` but there are no frames for `tool_call_request` (model wants to call a tool) or `tool_call_result` (tool execution result sent back).

## Tool Definition Flow (DB → Runtime)

```
public.tool table (21 seeded definitions)
  ↓
public.agent_tool join (which tools each agent has)
  ↓
Platform resolves agent's tools from DB
  ↓
Platform includes tool_definitions[] in dispatch to runtime
  ↓
Runtime translates to provider format (ToolSpec module)
  ↓
Runtime sends translated tools to helper via relay
  ↓
Helper passes to model in the API call
```

Tool calls are recorded in `public.tool_call` linked to `public.message`,
so the conversation history includes which tools were called, with what
input, and what output — regardless of which model was used.

## Architecture — Runtime's Role in Tool Calling

```
Platform sends dispatch with tool_definitions[]
  |
  v
Runtime receives dispatch in Runner.LocalRelay
  |
  v
Runtime translates tool definitions to provider format
  (OpenAI function_calling, Anthropic tool_use, prompt-based)
  |
  v
Runtime sends prompt + translated tools to helper via relay
  |
  v
Helper forwards to local model, model responds
  |
  +--[tool_call response]
  |    |
  |    v
  |  Helper sends tool_call_request frame back to runtime
  |    |
  |    v
  |  Runtime dispatches tool_execution_request frame to helper
  |    |
  |    v
  |  Helper executes tool locally, sends tool_call_result frame
  |    |
  |    v
  |  Runtime appends result to conversation, sends next turn to helper
  |  (loop until no more tool calls or max iterations)
  |
  +--[final text response]
       |
       v
     Runtime emits complete frame to platform
```

### Alternative: Helper-Side Loop (Recommended for Latency)

For lower latency, the tool-calling loop can run entirely on the helper side (avoiding round-trips to cloud for each tool call). In this mode:

```
Runtime sends dispatch with tool_definitions[] to helper
  |
  v
Helper runs the full tool-calling loop locally:
  model -> tool_call -> execute -> result -> model -> ...
  (emitting progress frames for each tool call)
  |
  v
Helper sends complete frame with final response
```

The runtime still needs to handle tool-call events for observability and to support the cloud-managed loop as a fallback when the helper doesn't support autonomous tool execution.

## PR Plan

### PR1: Tool Spec Normalization

**Branch:** `feat/tool-spec-normalization`

**Files:**
- `apps/orchestrator/lib/symphony_elixir/tool_spec.ex` — Model-agnostic tool spec normalization and provider translation
- `apps/orchestrator/test/symphony_elixir/tool_spec_test.exs` — Tests

**Module design:**

```elixir
defmodule SymphonyElixir.ToolSpec do
  @moduledoc """
  Translates model-agnostic tool definitions into provider-specific formats.
  """

  # Maps to the public.tool table row shape (see harper-server PR #495).
  # The platform loads tool definitions from the DB via agent_tool join
  # and includes them in the dispatch frame.
  @type tool_definition :: %{
    name: String.t(),          # tool.slug
    description: String.t(),   # tool.description
    parameters_schema: map(),  # tool.parameters (JSON Schema)
    execution_kind: String.t(),# tool.execution_kind
    runner_kind: String.t()    # tool.runner_kind
  }

  @type provider :: :openai | :anthropic | :openai_compatible | :prompt_based

  @doc "Translate a list of tool definitions to provider-specific tool specs."
  @spec to_provider_format([tool_definition()], provider()) :: [map()]
  def to_provider_format(tools, provider)

  @doc "Translate a single tool definition."
  @spec translate_tool(tool_definition(), provider()) :: map()
  def translate_tool(tool, provider)

  @doc "Build a prompt-based tool use system message for models without native support."
  @spec prompt_based_system_message([tool_definition()]) :: String.t()
  def prompt_based_system_message(tools)

  @doc "Parse a prompt-based tool call from model text output."
  @spec parse_prompt_based_tool_call(String.t()) :: {:ok, tool_call()} | :no_tool_call
  def parse_prompt_based_tool_call(text)
end
```

**Provider translations:**

| Provider | Format |
|----------|--------|
| `openai` / `openai_compatible` | `%{"type" => "function", "function" => %{"name" => name, "description" => desc, "parameters" => schema}}` |
| `anthropic` | `%{"name" => name, "description" => desc, "input_schema" => schema}` |
| `prompt_based` | System prompt with JSON tool-call instructions (no tools in API payload) |

**Acceptance criteria:**
- [ ] Translates to OpenAI function_calling format
- [ ] Translates to Anthropic tool_use format
- [ ] Generates prompt-based system message with clear JSON format instructions
- [ ] Parses prompt-based tool calls from model text (handles code fences, partial JSON)
- [ ] Handles edge cases: empty tools list, missing description, complex nested JSON Schema parameters
- [ ] Validates tool names match `^[a-z][a-z0-9_]{0,62}$`

**Sequencing:** No dependencies. Can start immediately.

---

### PR2: Tool Execution Dispatch via Relay

**Branch:** `feat/tool-execution-dispatch`

**Files:**
- `apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex` — Extend dispatch frame with tool definitions, handle tool_call events
- `apps/orchestrator/lib/symphony_elixir/local_relay/protocol_extensions.ex` — New frame types for tool calling
- `apps/orchestrator/test/symphony_elixir/runner/local_relay_tool_test.exs` — Tests

**New protocol frame types:**

```elixir
# Sent by helper when model returns tool_call(s)
# (only used in cloud-managed loop mode)
%{
  "type" => "tool_call_request",
  "correlation_id" => "...",
  "tool_calls" => [
    %{
      "id" => "call_abc123",
      "name" => "read_file",
      "arguments" => %{"path" => "src/main.ts"}
    }
  ]
}

# Sent by runtime to helper to execute a tool
# (only used in cloud-managed loop mode)
%{
  "type" => "tool_execution_request",
  "correlation_id" => "...",
  "tool_call_id" => "call_abc123",
  "name" => "read_file",
  "arguments" => %{"path" => "src/main.ts"},
  "execution_kind" => "filesystem_read",
  "execution_config" => %{}
}

# Sent by helper after tool execution
# (only used in cloud-managed loop mode)
%{
  "type" => "tool_call_result",
  "correlation_id" => "...",
  "tool_call_id" => "call_abc123",
  "success" => true,
  "output" => "contents of src/main.ts..."
}
```

**Extended dispatch frame:**

```elixir
# Added fields to existing dispatch frame
%{
  "type" => "dispatch",
  "correlation_id" => "...",
  # ... existing fields ...
  "tool_definitions" => [
    %{
      "name" => "read_file",
      "description" => "Read contents of a file",
      "parameters_schema" => %{"type" => "object", "properties" => %{"path" => %{"type" => "string"}}},
      "execution_kind" => "filesystem_read",
      "execution_config" => %{"allowed_paths" => ["src/", "docs/"]}
    }
  ],
  "tool_calling_mode" => "helper_managed" | "cloud_managed",
  "tool_calling_config" => %{
    "max_iterations" => 10,
    "timeout_per_tool_ms" => 30000,
    "total_timeout_ms" => 300000
  }
}
```

**Acceptance criteria:**
- [ ] Dispatch frame includes tool_definitions when agent has tools configured
- [ ] Tool definitions translated to provider format before dispatch (using PR1's ToolSpec)
- [ ] Runtime emits `:tool_call_started` and `:tool_call_completed` events for observability
- [ ] New frame types added to protocol vocabulary
- [ ] Helper-managed mode: runtime passes tools and lets helper handle the loop
- [ ] Cloud-managed mode: runtime receives tool_call_request, dispatches execution, sends result back

**Sequencing:** Depends on PR1 (ToolSpec).

---

### PR3: Multi-Turn Orchestration

**Branch:** `feat/tool-calling-orchestration`

**Files:**
- `apps/orchestrator/lib/symphony_elixir/runner/tool_calling_loop.ex` — Cloud-managed tool-calling loop
- `apps/orchestrator/test/symphony_elixir/runner/tool_calling_loop_test.exs` — Tests
- `apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex` — Wire loop into `run_turn/3`

**Module design:**

```elixir
defmodule SymphonyElixir.Runner.ToolCallingLoop do
  @moduledoc """
  Manages the multi-turn tool-calling loop for cloud-managed tool execution.

  Orchestrates: model -> tool_call -> execute -> result -> model -> ...
  until the model responds without tool calls or limits are reached.
  """

  @type config :: %{
    max_iterations: pos_integer(),
    timeout_per_tool_ms: pos_integer(),
    total_timeout_ms: pos_integer()
  }

  @type loop_state :: %{
    iteration: non_neg_integer(),
    tool_calls: [map()],
    messages: [map()],
    started_at: DateTime.t()
  }

  @doc "Run the tool-calling loop. Returns when model gives final response or limits hit."
  @spec run(session :: map(), config()) :: {:ok, map()} | {:error, term()}
  def run(session, config)

  @doc "Process a single tool-call response from the model."
  @spec handle_tool_calls(loop_state(), [map()], session :: map()) :: {:continue, loop_state()} | {:error, term()}
  def handle_tool_calls(state, tool_calls, session)
end
```

**Loop behavior:**

1. Runtime sends dispatch with tools to helper
2. Helper sends back response (either complete or tool_call_request)
3. If tool_call_request:
   a. Runtime logs tool call start event
   b. Runtime sends tool_execution_request to helper
   c. Helper executes and returns tool_call_result
   d. Runtime logs tool call completion event
   e. Runtime builds next turn messages and re-dispatches
4. If complete: return final response
5. Safety limits:
   - Max iterations (default 10, configurable per agent)
   - Per-tool timeout (default 30s)
   - Total loop timeout (default 5min)
   - Infinite loop detection (same tool + same args repeated 3x)

**Acceptance criteria:**
- [ ] Cloud-managed loop runs to completion for simple tool-calling scenarios
- [ ] Max iteration limit enforced with clear error
- [ ] Per-tool and total timeout enforced
- [ ] Infinite loop detection (repeated identical tool calls)
- [ ] Each iteration emits structured events for observability
- [ ] Failed tool executions returned as error content to model (not loop-breaking)
- [ ] Invalid tool names from model returned as error content (not loop-breaking)
- [ ] Works with prompt-based fallback (ToolSpec.parse_prompt_based_tool_call)

**Sequencing:** Depends on PR2 (dispatch).

---

## Sequencing Diagram

```
PR1: Tool Spec Normalization ─────────┐
                                       |
                                       v
                            PR2: Tool Execution Dispatch
                                       |
                                       v
                            PR3: Multi-Turn Orchestration
```

## Cross-Cutting Concerns

### Integration with existing tool infrastructure

The existing `DynamicTool` and `ToolPolicy` modules handle Codex-specific tools (Linear, database, repository). These will continue to work unchanged for Codex agents. The new universal tool infrastructure is for relay-dispatched (local model) agents. Long-term, the Codex tools could be migrated to the same model-agnostic definitions, but that is out of scope for this iteration.

### Helper-managed vs cloud-managed loop

| Aspect | Helper-Managed | Cloud-Managed |
|--------|---------------|---------------|
| Latency | Lower (no cloud round-trips per tool call) | Higher (cloud round-trip per tool call) |
| Observability | Events streamed via progress frames | Full control in runtime |
| Security | Helper enforces sandboxing | Runtime can add additional policy |
| Complexity | Helper needs full loop logic | Runtime manages loop state |

**Recommendation:** Start with helper-managed mode (dispatch tools + let helper loop). Add cloud-managed as fallback for when helper doesn't support it.

### Provider-specific tool_call response parsing

| Provider | Tool call format |
|----------|-----------------|
| OpenAI / OpenAI-compatible | `choices[0].message.tool_calls[{id, type: "function", function: {name, arguments}}]` |
| Anthropic | `content[{type: "tool_use", id, name, input}]` |
| Prompt-based | Parse JSON from model text: `{"tool_call": {"name": "...", "arguments": {...}}}` |

The helper's openai_compatible runner already parses `choices` but ignores `tool_calls`. PR2 in the helper scoping doc covers adding tool_call parsing.

### Error handling

| Error | Handling |
|-------|----------|
| Model hallucinates tool name not in definitions | Return error message as tool result, continue loop |
| Tool execution timeout | Return timeout error as tool result, continue loop |
| Total loop timeout | Break loop, return partial output with `:turn_ended_with_error` |
| Helper goes offline mid-loop | Retry with exponential backoff, then `:retryable` error |
| Model returns malformed tool_call arguments | Return parse error as tool result, continue loop |

### Observability

Each tool call in the loop will emit a structured event:

```elixir
%{
  event: :tool_call_completed,  # or :tool_call_started, :tool_call_failed
  payload: %{
    "correlation_id" => "...",
    "iteration" => 2,
    "tool_name" => "read_file",
    "tool_call_id" => "call_abc123",
    "arguments" => %{"path" => "src/main.ts"},
    "success" => true,
    "duration_ms" => 142,
    "result_size_bytes" => 4096,
    "provider" => "openai_compatible",
    "model" => "qwen2.5-coder:7b",
    "is_prompt_based" => false
  }
}
```

### Existing infrastructure to build on

- `Runner.Contract.event_names/0` already includes tool-call event names
- `Runner.LocalRelay.normalize_backend_event/2` already handles `"tool.started"` and `"tool.completed"` progress events
- `LocalRelay.Registry` handles dispatch routing and cancellation
- Protocol frames (`internal/protocol/protocol.go` in helper) support extensible JSON payloads via `json.RawMessage`
