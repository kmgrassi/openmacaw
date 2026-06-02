# Unified Tool Contract — Master Scoping Document

## Problem

Tool calling in this system is implemented five different ways with
incompatible signatures, two parallel tool-calling loops, and three
separate "local model" code paths. Each agent type (codex, planner,
manager, computer_use, openclaw, claude_code, local_model_coding,
local_relay) has its own tool dispatch surface. Adding a tool requires
deciding which of these to wire into; making the local model serve as
planner/manager/coder requires repeating that decision per agent type.

This document supersedes the in-scope decisions of
`universal-tool-calling-plan.md` (which explicitly excluded the Codex
tool path). The new direction: **one tool contract, one dispatcher, one
canonical tool-call shape**, used by every runner regardless of model
provider, with per-agent customization layered on top.

## Goals

1. **One `Tool` behaviour.** Every tool implements the same module
   contract (`name/0`, `description/0`, `parameters_schema/0`,
   `execute(arguments, context)`) and returns the same result shape.
2. **One `ToolRegistry` dispatcher.** Every runner — cloud or local,
   helper-driven or runtime-driven — calls the same function:
   `ToolRegistry.execute(tool_name, arguments, context, allowed_tools)`.
3. **One canonical tool-call shape.** Tool definitions sent to any
   model and tool-call responses parsed from any model normalize to a
   single internal representation. Provider adapters translate to/from
   OpenAI, Anthropic, OpenAI-compatible, prompt-based formats.
4. **Per-agent effective grants.** A global registry defines what
   runtime-owned tools exist. The model-facing tool set for a turn is
   the enabled effective grant set supplied by Platform from
   `agent_tool_grant` rows.
5. **One model-relay transport.** The three current local-model paths
   (`Runner.LocalRelay`, `Runner.LocalModelCoding`,
   `Manager.ModelClient.LocalRelay`) collapse to a single
   `LocalRelay.Session` module that owns frames, correlation IDs,
   timeouts, and the receive loop. Per-agent behavior plugs in as a
   handler module that calls `ToolRegistry.execute`.
6. **One tool-calling loop.** `Runner.ToolCallingLoop` and the inline
   loop in `LocalModelCoding` collapse into one module parameterized by
   model transport and allowed-tool set.

## Non-goals

- Migrating Codex/OpenClaw/ClaudeCode/ComputerUse runner internals.
  Only their tool dispatch goes through `ToolRegistry`; the runners
  themselves keep their existing structure.
- Replacing the helper daemon's internal tool execution. When the
  helper runs tools (`tool_calling_mode: helper_managed`), it stays
  as-is — but it accepts the unified tool spec shape on the wire.
- Defining the persistent tool-policy schema. The current data-model
  direction is tracked in
  [agent-tool-grant-data-model-runtime-scope.md](agent-tool-grant-data-model-runtime-scope.md):
  `tool_policy_template` rows are write-time presets, and
  `agent_tool_grant` rows are the runtime source of truth.

## Design

### The canonical shapes

**Tool definition** (one shape, used everywhere internally):

```elixir
%{
  name: "task.create",                # ^[a-z][a-z0-9_.]{0,62}$
  description: "Create a planner task",
  parameters_schema: %{...JSONSchema...},
  metadata: %{
    bundle: :planner,                 # which named bundle this belongs to
    execution_kind: :runtime,         # :runtime | :helper | :external
    requires_context: [:workspace_id]
  }
}
```

**Tool call** (parsed from any provider, dispatched to any executor):

```elixir
%{
  id: "call_abc123",
  name: "task.create",
  arguments: %{...},                  # already-parsed map; never JSON string
  raw: %{...}                          # original provider payload, for trace
}
```

**Tool result** (returned by every tool, fed back to any provider):

```elixir
{:ok, %{output: term, usage: map | nil, metadata: map | nil}}
{:error, reason :: atom | {atom, term} | %{...}}
```

### The behaviour

```elixir
defmodule SymphonyElixir.Tool do
  @callback name() :: String.t()
  @callback description() :: String.t()
  @callback parameters_schema() :: map()
  @callback bundle() :: atom() | [atom()]
  @callback execution_kind() :: :runtime | :helper | :external
  @callback execute(arguments :: map(), context :: map()) ::
              {:ok, map()} | {:error, term()}
end
```

`context` is one map with documented keys: `:workspace_id`,
`:agent_id`, `:user_id`, `:run_id`, `:work_item`, `:credentials`,
`:trace_id`, `:tool_call_id`, `:execution_profile`. Every tool sees the
same shape.

### The registry

```elixir
defmodule SymphonyElixir.ToolRegistry do
  def register(tool_module)
  def get(tool_name) :: {:ok, tool_module} | :error
  def bundle(name) :: [tool_name :: String.t()]
  def resolve_for_agent(agent_id) :: [tool_module]
  def execute(tool_name, arguments, context, allowed_tools) ::
        {:ok, result} | {:error, :not_allowed | :unknown_tool | term}
  def provider_specs(tools, provider) :: [map()]
end
```

`resolve_for_agent/1`, if Runtime owns direct resolution, reads enabled
`agent_tool_grant` rows joined to `tool`. It must not read
`tool_policy_template` rows, because templates are only creation/defaulting
inputs after Platform has materialized grants.

### Provider adapters

One module per provider, each implementing a small contract:

```elixir
defmodule SymphonyElixir.ToolAdapter do
  @callback to_tool_specs(tools :: [tool_def]) :: [map()]
  @callback parse_tool_calls(provider_response :: map()) :: [tool_call]
  @callback format_tool_result(tool_call_id, result) :: map()
end
```

Implementations: `OpenAI`, `Anthropic`, `OpenAICompatible`,
`PromptBased`. Each runner picks an adapter by provider; everything
above the adapter speaks canonical shapes.

### Per-agent effective grants

Runtime treats tool policy as a resolved input. For each turn/start,
the model-facing tool list is:

```text
enabled tool definitions from agent_tool_grant
```

Named templates can still exist in Platform and Harper Server, but they
only explain how grants were created. They do not add tools at runtime
unless Platform has converted them into effective `agent_tool_grant`
rows. Runtime-owned dispatch still uses `ToolRegistry.execute/4`, and
the `allowed_tools` argument is derived from the effective grant names
for that turn.

### Local-model transport unification

After the registry exists, the three local-model paths collapse to
**one** `LocalRelay.Session` module + thin handler modules. See
`docs/unified-tool-contract-runtime-prs.md` for details.

## PR plans by repo

| Repo | Document | PR count |
|---|---|---|
| `parallel-agent-runtime` | [unified-tool-contract-runtime-prs.md](unified-tool-contract-runtime-prs.md) | 8 |
| `parallel-agent-platform` | [unified-tool-contract-platform-prs.md](unified-tool-contract-platform-prs.md) | 4 |
| `local-runtime-helper` | [unified-tool-contract-helper-prs.md](unified-tool-contract-helper-prs.md) | 2 |
| `harper-server` | [unified-tool-contract-harper-prs.md](unified-tool-contract-harper-prs.md) | 1 |

## Cross-repo sequencing

```
Harper/Platform grant model (`agent_tool_grant` effective rows)
   |
   v
runtime PR1 (Tool behaviour + Registry skeleton)
   |
   +---> runtime PR2 (migrate Manager.Tools)
   |        |
   |        v
   |     runtime PR3 (migrate Planner.DatabaseTools + RepositoryTools)
   |        |
   |        v
   |     runtime PR4 (migrate LocalModelCoding executors)
   |        |
   |        v
   |     runtime PR5 (migrate Codex.DynamicTool — last; biggest)
   |
   +---> runtime PR6 (canonical tool-call shape + provider adapters)
            |
            v
         runtime PR7 (LocalRelay.Session extraction + handler modules)
            |
            v
         runtime PR8 (unify ToolCallingLoop + LocalModelCoding loop)
            |
            v
         platform PR1 (planner-via-local routing)
            |
            v
         platform PR2 (per-agent tool grant API)
            |
            v
         platform PR3 (per-agent tool grant UI)
            |
            v
         platform PR4 (planner local-model E2E wiring + execution profile)

Helper PR1 (unified tool spec shape on wire) parallel with runtime PR6
Helper PR2 (generic runtime-executes-tools mode) parallel with runtime PR7
```

## Risks

- **Codex migration is the largest blast radius.** `Codex.DynamicTool`
  is used by the production cloud planner. Sequenced last to give the
  registry surface time to harden against simpler agents first.
- **Provider adapters will surface untested edge cases.** Every model
  has its own quirks for malformed arguments, parallel tool calls,
  empty arguments, escaped JSON. Build adapters with a property-based
  test that round-trips canonical → provider → canonical.
- **Per-agent grants change DB query patterns.** Effective tool
  resolution reads `agent_tool_grant` rows joined to `tool`. Verify
  cache strategy before turning on for high-traffic agents.

## Related prior docs

- [universal-tool-calling-plan.md](universal-tool-calling-plan.md) —
  earlier scope; explicitly excluded Codex. This doc supersedes that
  scope decision.
- [manager-local-model-scope.md](manager-local-model-scope.md) — the
  manager-via-local-model work that produced `Manager.ModelClient.LocalRelay`.
  Becomes one of three handlers under the new `LocalRelay.Session`.
- [cloud-local-relay-pr-plan.md](cloud-local-relay-pr-plan.md) — the
  cloud-managed loop work that produced `Runner.ToolCallingLoop`.
  That loop is one of two that PR8 unifies.
