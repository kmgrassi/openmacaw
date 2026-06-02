defmodule SymphonyElixir.Diagnostic.AgentProbe do
  @moduledoc """
  Dry-run diagnostic probe for a single agent.

  The probe follows the same gateway profile resolution used by chat, validates
  the runner module, starts a probe-only runner session, and immediately cleans
  it up. It never calls `run_turn/3`.
  """

  alias SymphonyElixir.{Config, ExecutionProfile}
  alias SymphonyElixir.Diagnostic.ContainerInventory
  alias SymphonyElixir.Gateway.AgentExecutionProfile

  @type reason ::
          :gateway_config_missing
          | :execution_profile_unresolved
          | :credential_missing
          | :runner_spawn_failed
          | :cleanup_failed

  @spec probe(String.t(), String.t()) :: {:ok, :ready} | {:error, reason(), map()}
  def probe(workspace_id, agent_id) when is_binary(workspace_id) and is_binary(agent_id) do
    probe(workspace_id, agent_id, [])
  end

  def probe(_workspace_id, _agent_id),
    do: {:error, :gateway_config_missing, %{reason: :invalid_scope}}

  @doc false
  @spec probe(String.t(), String.t(), keyword()) :: {:ok, :ready} | {:error, reason(), map()}
  def probe(workspace_id, agent_id, opts)
      when is_binary(workspace_id) and is_binary(agent_id) and is_list(opts) do
    profile_resolver = Keyword.get(opts, :profile_resolver, AgentExecutionProfile)
    runner_resolver = Keyword.get(opts, :runner_resolver, ExecutionProfile)

    with {:ok, profile} <- resolve_profile(profile_resolver, agent_id, workspace_id),
         {:ok, runner} <- resolve_runner(runner_resolver, profile),
         :ok <- validate_credential(profile),
         {:ok, session, workspace} <- start_probe_session(runner, profile, opts) do
      try do
        stop_probe_session(runner, session)
      after
        cleanup_probe_workspace(workspace)
      end
    end
  end

  defp resolve_profile(resolver, agent_id, workspace_id) do
    case resolver.resolve(agent_id, workspace_id) do
      {:ok, profile} when is_map(profile) ->
        {:ok, profile}

      {:error, :not_found} ->
        {:error, :gateway_config_missing, %{agent_id: agent_id, workspace_id: workspace_id}}

      {:error, :credential_missing} ->
        {:error, :credential_missing, %{agent_id: agent_id, workspace_id: workspace_id}}

      {:error, {:credential_unresolved, reason}} ->
        {:error, :credential_missing, %{agent_id: agent_id, workspace_id: workspace_id, reason: inspect(reason)}}

      {:error, reason} ->
        {:error, :execution_profile_unresolved, %{agent_id: agent_id, workspace_id: workspace_id, reason: inspect(reason)}}
    end
  end

  defp resolve_runner(resolver, profile) do
    profile
    |> profile_for_execution()
    |> resolver.runner_module()
    |> case do
      {:ok, runner} ->
        {:ok, runner}

      {:error, reason} ->
        {:error, :execution_profile_unresolved, %{reason: inspect(reason), profile: sanitized_profile(profile)}}
    end
  end

  defp validate_credential(profile) do
    case map_value(profile, :api_key) do
      value when is_binary(value) and value != "" ->
        :ok

      _value ->
        if credential_optional?(profile) do
          :ok
        else
          {:error, :credential_missing, %{profile: sanitized_profile(profile)}}
        end
    end
  end

  defp credential_optional?(profile) do
    map_value(profile, :provider) in ["openai_compatible", "local"]
  end

  defp start_probe_session(runner, profile, opts) do
    config = probe_runner_config(profile, opts)
    workspace = probe_workspace(runner, profile, opts)

    try do
      case runner.start_session(config, workspace) do
        {:ok, session} ->
          {:ok, session, workspace}

        {:error, reason} ->
          cleanup_probe_workspace(workspace)
          {:error, :runner_spawn_failed, runner_failure_details(reason, profile)}
      end
    rescue
      error ->
        cleanup_probe_workspace(workspace)

        {:error, :runner_spawn_failed, runner_failure_details({error.__struct__, Exception.message(error)}, profile)}
    catch
      kind, reason ->
        cleanup_probe_workspace(workspace)
        {:error, :runner_spawn_failed, runner_failure_details({kind, reason}, profile)}
    end
  end

  defp stop_probe_session(runner, session) do
    case runner.stop_session(session) do
      :ok -> {:ok, :ready}
      {:error, reason} -> {:error, :cleanup_failed, %{reason: inspect(reason)}}
    end
  rescue
    error ->
      {:error, :cleanup_failed, %{reason: Exception.message(error)}}
  catch
    kind, reason ->
      {:error, :cleanup_failed, %{reason: inspect({kind, reason})}}
  end

  defp probe_runner_config(profile, opts) do
    profile_map = profile_for_execution(profile)
    base_config = Keyword.get(opts, :base_runner_config, %{})

    profile_map
    |> ExecutionProfile.runner_config(base_config)
    |> Map.merge(atom_profile_fields(profile))
    |> Map.put("probe_only", true)
    |> Map.put(:probe_only, true)
    |> Map.put("execution_profile", ExecutionProfile.sanitize(profile_map))
  end

  defp probe_workspace(runner, profile, opts) do
    if runner.requires_workspace?() do
      workspace_root =
        Keyword.get(opts, :workspace_root) || map_value(profile, :workspace_root) ||
          Config.settings!().workspace.root

      workspace =
        Path.join(
          workspace_root,
          ".agent-probe-#{System.unique_integer([:positive, :monotonic])}"
        )

      File.mkdir_p!(workspace)
      workspace
    else
      nil
    end
  end

  defp cleanup_probe_workspace(nil), do: :ok

  defp cleanup_probe_workspace(workspace) do
    File.rm_rf(workspace)
    :ok
  end

  defp runner_failure_details(reason, profile) do
    %{
      reason: inspect(reason),
      profile: sanitized_profile(profile),
      container_inventory: ContainerInventory.binary_slice(required_binaries(profile))
    }
    |> maybe_put_binary(reason, profile)
  end

  defp maybe_put_binary(details, reason, profile) do
    binary =
      cond do
        reason in [:codex_not_found, {:error, :codex_not_found}] -> "codex"
        reason in [:bash_not_found, {:error, :bash_not_found}] -> "bash"
        map_value(profile, :runner_kind) == "claude_code" -> "node"
        true -> nil
      end

    if binary, do: Map.put(details, :binary, binary), else: details
  end

  defp required_binaries(profile) do
    case map_value(profile, :runner_kind) do
      "codex" -> ["bash", "codex"]
      "claude_code" -> ["node"]
      _runner_kind -> []
    end
  end

  defp profile_for_execution(profile) do
    profile
    |> stringify_keys()
    |> Map.put_new("role", "coding")
  end

  defp atom_profile_fields(profile) do
    profile
    |> Enum.map(fn {key, value} -> {to_string(key), value} end)
    |> Map.new()
  end

  defp sanitized_profile(profile),
    do: profile |> profile_for_execution() |> ExecutionProfile.sanitize()

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), normalize_value(value)}
      {key, value} -> {key, normalize_value(value)}
    end)
  end

  defp normalize_value(value) when is_map(value), do: stringify_keys(value)
  defp normalize_value(value), do: value

  defp map_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))
  defp map_value(_map, _key), do: nil
end
