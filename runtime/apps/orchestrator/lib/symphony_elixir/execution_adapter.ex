defmodule SymphonyElixir.ExecutionAdapter do
  @moduledoc """
  Provider-neutral boundary for isolated execution environments.

  Existing runner dispatch continues to use `SymphonyElixir.Runner` directly.
  This contract is for cloud/container materialization paths that need an
  explicit execution target, resource descriptors, and structured pre-launch
  errors.
  """

  alias SymphonyElixir.ExecutionAdapter.Error

  @type execution_mode :: :planning_read_only | :coding_workspace_write
  @type target :: :local_helper | :aws

  @type resource :: %{
          optional(:id) => String.t(),
          optional(:resource_id) => String.t(),
          optional(:grant_id) => String.t(),
          optional(:kind) => String.t(),
          optional(:provider) => String.t(),
          optional(:alias) => String.t(),
          optional(:locator) => String.t(),
          optional(:ref) => String.t(),
          optional(:required) => boolean()
        }

  @type request :: %{
          required(:workspace_id) => String.t(),
          required(:agent_id) => String.t(),
          required(:run_id) => String.t(),
          optional(:session_id) => String.t(),
          required(:execution_mode) => execution_mode(),
          optional(:resources) => [resource()],
          optional(:limits) => map(),
          optional(:artifact_retention) => map(),
          optional(:network_policy) => map(),
          optional(:adapter_config) => map()
        }

  @type result :: %{
          required(:adapter) => String.t(),
          required(:status) => String.t(),
          optional(:run_id) => String.t(),
          optional(:target) => String.t(),
          optional(:metadata) => map()
        }

  @callback start_run(request()) :: {:ok, result()} | {:error, Error.t()}
  @callback validate_config(map()) :: :ok | {:error, Error.t()}

  @supported_targets %{
    "local_helper" => SymphonyElixir.ExecutionAdapter.LocalHelper,
    "local_relay" => SymphonyElixir.ExecutionAdapter.LocalHelper,
    "local" => SymphonyElixir.ExecutionAdapter.LocalHelper,
    "aws" => SymphonyElixir.ExecutionAdapter.Aws,
    "container" => SymphonyElixir.ExecutionAdapter.Aws,
    "ecs" => SymphonyElixir.ExecutionAdapter.Aws
  }

  @doc """
  Resolve an adapter module from a target atom/string or request map.
  """
  @spec resolve(target() | String.t() | map()) :: {:ok, module()} | {:error, Error.t()}
  def resolve(%{} = request), do: resolve(target_from_request(request))
  def resolve(:local_helper), do: {:ok, SymphonyElixir.ExecutionAdapter.LocalHelper}
  def resolve(:aws), do: {:ok, SymphonyElixir.ExecutionAdapter.Aws}

  def resolve(target) when is_binary(target) do
    case Map.fetch(@supported_targets, normalize_target(target)) do
      {:ok, module} ->
        {:ok, module}

      :error ->
        {:error,
         Error.new(:unsupported_execution_target, "Unsupported execution adapter target", %{
           target: target,
           supported_targets: Map.keys(@supported_targets)
         })}
    end
  end

  def resolve(target) do
    {:error,
     Error.new(:unsupported_execution_target, "Unsupported execution adapter target", %{
       target: inspect(target),
       supported_targets: Map.keys(@supported_targets)
     })}
  end

  @doc """
  Start a run through the selected adapter.
  """
  @spec start_run(map()) :: {:ok, result()} | {:error, Error.t()}
  def start_run(%{} = request) do
    with {:ok, adapter} <- resolve(request) do
      adapter.start_run(normalize_request(request))
    end
  end

  defp target_from_request(request) do
    value_at(request, "execution_target") ||
      value_at(request, "target") ||
      value_at(request, ["execution_profile", "adapter_config", "execution_target"]) ||
      value_at(request, ["adapter_config", "execution_target"]) ||
      "local_helper"
  end

  defp value_at(map, key) when is_map(map) and is_binary(key) do
    atom_key = path_atom_key(key)

    cond do
      Map.has_key?(map, key) -> Map.get(map, key)
      atom_key && Map.has_key?(map, atom_key) -> Map.get(map, atom_key)
      true -> nil
    end
  end

  defp value_at(map, [key]) when is_map(map), do: value_at(map, key)

  defp value_at(map, [key | rest]) when is_map(map) do
    case value_at(map, key) do
      nested when is_map(nested) -> value_at(nested, rest)
      _other -> nil
    end
  end

  defp value_at(value, []) when is_binary(value), do: value
  defp value_at(_value, []), do: nil
  defp value_at(_map, _path), do: nil

  defp path_atom_key("execution_target"), do: :execution_target
  defp path_atom_key("target"), do: :target
  defp path_atom_key("execution_profile"), do: :execution_profile
  defp path_atom_key("adapter_config"), do: :adapter_config
  defp path_atom_key(_key), do: nil

  defp normalize_target(target), do: target |> String.trim() |> String.downcase()

  defp normalize_request(request) do
    request
    |> atomize_known_key(:workspace_id)
    |> atomize_known_key(:agent_id)
    |> atomize_known_key(:run_id)
    |> atomize_known_key(:session_id)
    |> atomize_known_key(:execution_mode)
    |> atomize_known_key(:resources)
    |> atomize_known_key(:limits)
    |> atomize_known_key(:artifact_retention)
    |> atomize_known_key(:network_policy)
    |> atomize_known_key(:adapter_config)
    |> normalize_execution_mode()
  end

  defp atomize_known_key(request, key) do
    string_key = Atom.to_string(key)

    case Map.fetch(request, string_key) do
      {:ok, value} -> Map.put_new(request, key, value)
      :error -> request
    end
  end

  defp normalize_execution_mode(%{execution_mode: mode} = request) when is_binary(mode) do
    normalized =
      case mode |> String.trim() |> String.downcase() do
        "planning_read_only" -> :planning_read_only
        "coding_workspace_write" -> :coding_workspace_write
        other -> other
      end

    Map.put(request, :execution_mode, normalized)
  end

  defp normalize_execution_mode(request), do: request
end
