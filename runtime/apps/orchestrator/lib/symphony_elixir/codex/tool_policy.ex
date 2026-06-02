defmodule SymphonyElixir.Codex.ToolPolicy do
  @moduledoc """
  Resolves Codex app-server tool exposure from the stored agent kind and policy.
  """

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.ToolRegistry

  @type agent_kind :: String.t()
  @type resolved :: %{
          agent_kind: agent_kind(),
          dynamic_tool_specs: [map()],
          dynamic_tool_names: [String.t()],
          thread_sandbox: String.t(),
          turn_sandbox_policy: map()
        }

  @spec normalize_agent_kind(term()) :: agent_kind()
  def normalize_agent_kind(kind), do: Agent.kind(kind)

  @spec coding?(term()) :: boolean()
  def coding?(kind), do: Agent.coding?(kind)

  @spec planning?(term()) :: boolean()
  def planning?(kind), do: Agent.planning?(kind)

  @spec custom?(term()) :: boolean()
  def custom?(kind), do: Agent.custom?(kind)

  @spec resolve(term(), map(), map()) :: resolved()
  def resolve(agent_kind, tool_policy, runtime_settings)
      when is_map(tool_policy) and is_map(runtime_settings) do
    kind = normalize_agent_kind(agent_kind)

    ToolRegistry.resolve_for_agent(kind, tool_policy, runtime_settings)
  end

  def resolve(agent_kind, _tool_policy, runtime_settings) when is_map(runtime_settings) do
    resolve(agent_kind, %{}, runtime_settings)
  end
end
