defmodule SymphonyElixir.ExecutionAdapter.Aws do
  @moduledoc """
  AWS/ECS execution adapter stub.

  RT-PR1 stops at validating the cloud execution boundary and returning a
  structured no-op result. RT-PR2 owns actual ECS task launch, polling, stop,
  and reconciliation.
  """

  @behaviour SymphonyElixir.ExecutionAdapter

  alias SymphonyElixir.ExecutionAdapter.Error

  @supported_modes [:planning_read_only, :coding_workspace_write]
  @required_config_keys ~w(cluster task_definition subnets security_groups)

  @impl true
  def validate_config(config) when is_map(config) do
    missing =
      @required_config_keys
      |> Enum.reject(fn key -> present?(config_value(config, key)) end)

    case missing do
      [] ->
        :ok

      _ ->
        {:error,
         Error.new(:missing_adapter_config, "AWS execution adapter is not configured", %{
           adapter: "aws",
           missing: missing
         })}
    end
  end

  def validate_config(_config) do
    {:error,
     Error.new(:missing_adapter_config, "AWS execution adapter config must be a map", %{
       adapter: "aws"
     })}
  end

  @impl true
  def start_run(%{} = request) do
    config = adapter_config(request)

    with :ok <- validate_execution_mode(Map.get(request, :execution_mode)),
         :ok <- validate_resource_grants(Map.get(request, :resources, [])),
         :ok <- validate_config(config),
         :ok <- validate_capacity(config) do
      {:ok,
       %{
         adapter: "aws",
         status: "hello_world_started",
         run_id: Map.get(request, :run_id),
         target: "aws",
         metadata: %{
           "cluster" => config_value(config, "cluster"),
           "task_definition" => config_value(config, "task_definition"),
           "mode" => Atom.to_string(Map.fetch!(request, :execution_mode)),
           "resource_count" => length(Map.get(request, :resources, []))
         }
       }}
    end
  end

  defp validate_execution_mode(mode) when mode in @supported_modes, do: :ok

  defp validate_execution_mode(mode) do
    {:error,
     Error.new(:unsupported_execution_mode, "Unsupported execution mode for AWS execution adapter", %{
       adapter: "aws",
       execution_mode: inspect(mode),
       supported_modes: Enum.map(@supported_modes, &Atom.to_string/1)
     })}
  end

  defp validate_resource_grants(resources) when is_list(resources) do
    missing =
      resources
      |> Enum.with_index()
      |> Enum.filter(fn {resource, _index} -> missing_grant?(resource) end)
      |> Enum.map(fn {resource, index} ->
        %{
          index: index,
          resource_id: map_value(resource, "resource_id") || map_value(resource, "id"),
          alias: map_value(resource, "alias")
        }
      end)

    case missing do
      [] ->
        :ok

      _ ->
        {:error,
         Error.new(:missing_resource_grant_metadata, "AWS resources require grant metadata", %{
           adapter: "aws",
           resources: missing
         })}
    end
  end

  defp validate_resource_grants(_resources) do
    {:error,
     Error.new(:missing_resource_grant_metadata, "AWS resources must be a list", %{
       adapter: "aws"
     })}
  end

  defp missing_grant?(resource) when is_map(resource) do
    not present?(map_value(resource, "grant_id") || map_value(resource, "grantId"))
  end

  defp missing_grant?(_resource), do: true

  defp validate_capacity(config) do
    case config_value(config, "capacity_available") do
      false ->
        {:error,
         Error.new(:unavailable_capacity, "AWS execution adapter capacity is unavailable", %{
           adapter: "aws"
         })}

      _ ->
        :ok
    end
  end

  defp adapter_config(request) do
    request_config = map_or_empty(Map.get(request, :adapter_config, %{}))

    application_config =
      :symphony_elixir
      |> Application.get_env(:aws_execution_adapter, %{})
      |> map_or_empty()

    env_config()
    |> Map.merge(application_config)
    |> Map.merge(request_config)
  end

  defp map_or_empty(value) when is_map(value), do: value
  defp map_or_empty(_value), do: %{}

  defp env_config do
    %{
      "cluster" => System.get_env("SYMPHONY_AWS_EXECUTION_CLUSTER"),
      "task_definition" => System.get_env("SYMPHONY_AWS_EXECUTION_TASK_DEFINITION"),
      "subnets" => split_env("SYMPHONY_AWS_EXECUTION_SUBNETS"),
      "security_groups" => split_env("SYMPHONY_AWS_EXECUTION_SECURITY_GROUPS")
    }
  end

  defp split_env(name) do
    case System.get_env(name) do
      nil -> nil
      value -> value |> String.split(",", trim: true) |> Enum.map(&String.trim/1)
    end
  end

  defp config_value(config, key) do
    atom_key = config_atom_key(key)

    cond do
      Map.has_key?(config, key) -> Map.get(config, key)
      atom_key && Map.has_key?(config, atom_key) -> Map.get(config, atom_key)
      true -> nil
    end
  end

  defp config_atom_key("cluster"), do: :cluster
  defp config_atom_key("task_definition"), do: :task_definition
  defp config_atom_key("subnets"), do: :subnets
  defp config_atom_key("security_groups"), do: :security_groups
  defp config_atom_key("capacity_available"), do: :capacity_available
  defp config_atom_key(_key), do: nil

  defp map_value(map, key) when is_map(map) do
    atom_key = resource_atom_key(key)

    cond do
      Map.has_key?(map, key) -> Map.get(map, key)
      atom_key && Map.has_key?(map, atom_key) -> Map.get(map, atom_key)
      true -> nil
    end
  end

  defp map_value(_map, _key), do: nil

  defp resource_atom_key("resource_id"), do: :resource_id
  defp resource_atom_key("id"), do: :id
  defp resource_atom_key("alias"), do: :alias
  defp resource_atom_key("grant_id"), do: :grant_id
  defp resource_atom_key("grantId"), do: :grant_id
  defp resource_atom_key(_key), do: nil

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(value) when is_list(value), do: value != []
  defp present?(nil), do: false
  defp present?(_value), do: true
end
