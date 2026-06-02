defmodule SymphonyElixir.Runner.Planner do
  @moduledoc """
  Planner runner.

  The runner selects a planner model client from the resolved execution profile
  and delegates provider-specific tool-calling behavior to that client.
  """

  @behaviour SymphonyElixir.Runner

  alias SymphonyElixir.Planner.ModelClient
  alias SymphonyElixir.Runner.AgentConfig

  @runner_kind "planner"

  @doc """
  Resolves a per-agent planner runtime knob from gateway config.

  Reads `runners.planner.<agent_id>.<key>` first, falling back to
  `runners.planner.<key>`, then `default`.

  Scaffolding for non-tool runtime knobs (cadence overrides,
  timeouts, custom instructions, rate limits, ...). Tool policy is
  owned by the agent tool data model, not this helper. Add knobs
  incrementally as the platform UI exposes them. See
  `docs/local-model-readiness-runtime-prs.md` (PR2).
  """
  @spec agent_config(String.t(), String.t() | nil, String.t() | atom(), term()) :: term()
  def agent_config(workspace_id, agent_id, key, default \\ nil) do
    AgentConfig.lookup(@runner_kind, workspace_id, agent_id, key, default)
  end

  @impl true
  def start_session(config, workspace) when is_map(config) do
    client = model_client(config)

    if probe_only?(config) do
      with :ok <- client.ping(config) do
        {:ok, %{probe_only: true, runner: "planner", model_client: client}}
      end
    else
      with {:ok, session} <- client.start_session(config, workspace) do
        {:ok, Map.put(session, :model_client, client)}
      end
    end
  end

  @impl true
  def run_turn(%{model_client: client} = session, prompt, work_item)
      when is_atom(client) and is_binary(prompt) do
    client.run_turn(session, prompt, work_item)
  end

  @impl true
  def stop_session(%{model_client: client} = session) when is_atom(client) do
    client.stop_session(session)
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) when is_map(config), do: model_client(config).ping(config)

  @impl true
  def requires_workspace?, do: false

  defp model_client(config) do
    case provider(config) do
      "local" -> ModelClient.LocalRelay
      :local -> ModelClient.LocalRelay
      _provider -> ModelClient.OpenAIResponses
    end
  end

  defp provider(config) do
    profile = map_value(config, :execution_profile) || map_value(config, :profile) || config
    map_value(profile, :provider) || map_value(config, :provider) || "openai"
  end

  defp map_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))
  defp map_value(_map, _key), do: nil

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false
end
