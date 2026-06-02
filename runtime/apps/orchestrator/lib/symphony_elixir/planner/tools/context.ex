defmodule SymphonyElixir.Planner.Tools.Context do
  @moduledoc false

  @opts [
    :actor,
    :agent_id,
    :config,
    :default_repository,
    :default_runner_kind,
    :planner_state,
    :repository,
    :req_options,
    :rg_path,
    :search_timeout_ms,
    :workspace,
    :workspace_id,
    :workspace_root
  ]

  @spec to_opts(map()) :: keyword()
  def to_opts(context) when is_map(context) do
    @opts
    |> Enum.reduce([], fn key, opts ->
      case Map.get(context, key) || Map.get(context, Atom.to_string(key)) do
        nil -> opts
        value -> [{key, value} | opts]
      end
    end)
    |> Enum.reverse()
  end
end
