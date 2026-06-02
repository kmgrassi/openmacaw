defmodule SymphonyElixir.Runner.AgentConfig do
  @moduledoc """
  Per-agent gateway-config lookup for runner kinds.

  Mirrors the manager scheduler pattern (`runners.manager.<agent_id>.<key>`
  falling back to `runners.manager.<key>`) and generalizes it so other
  runner kinds (planner, local_model_coding, ...) can read the same
  shape of configuration.

  Resolution order for `lookup(runner_kind, workspace_id, agent_id, key, default)`:

    1. `runners.<runner_kind>.<agent_id>.<key>` — per-agent override
    2. `runners.<runner_kind>.<key>` — workspace-level value
    3. `default`

  This module is scaffolding for non-tool runtime knobs (cadence,
  timeouts, custom instructions, rate limits, ...). Tool policy is
  owned by the agent tool data model overhaul and `resolveAgentToolPolicy`
  on the platform side; do not add tool-allow/deny logic here. New
  knobs should be added incrementally as the platform UI exposes them.

  See `docs/local-model-readiness-runtime-prs.md` (PR2) for context.
  """

  alias SymphonyElixir.Launcher.GatewayConfig

  @type runner_kind :: String.t()
  @type lookup_key :: String.t() | atom()

  @spec lookup(runner_kind(), String.t(), String.t() | nil, lookup_key(), term()) :: term()
  def lookup(runner_kind, workspace_id, agent_id, key, default \\ nil)
      when is_binary(runner_kind) and runner_kind != "" and is_binary(workspace_id) and
             workspace_id != "" do
    key_str = to_string(key)

    case GatewayConfig.fetch("workspace", workspace_id) do
      {:ok, %{config_json: config_json}} when is_map(config_json) ->
        agent_value =
          if is_binary(agent_id) and agent_id != "" do
            get_in(config_json, ["runners", runner_kind, agent_id, key_str])
          end

        workspace_value = get_in(config_json, ["runners", runner_kind, key_str])

        first_present([agent_value, workspace_value], default)

      _ ->
        default
    end
  end

  defp first_present([], default), do: default
  defp first_present([nil | rest], default), do: first_present(rest, default)
  defp first_present([value | _rest], _default), do: value
end
