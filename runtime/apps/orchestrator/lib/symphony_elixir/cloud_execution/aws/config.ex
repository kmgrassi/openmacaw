defmodule SymphonyElixir.CloudExecution.Aws.Config do
  @moduledoc """
  Runtime configuration for the AWS ECS task scheduler.
  """

  @required [:region, :cluster, :task_definition, :subnets]

  @type t :: %{
          required(:region) => String.t(),
          required(:cluster) => String.t(),
          required(:task_definition) => String.t(),
          required(:subnets) => [String.t()],
          optional(:security_groups) => [String.t()],
          optional(:container_name) => String.t() | nil,
          optional(:assign_public_ip) => String.t(),
          optional(:launch_type) => String.t(),
          optional(:platform_version) => String.t() | nil,
          optional(:task_store_path) => String.t()
        }

  @spec load(keyword() | map()) :: {:ok, t()} | {:error, {:aws_scheduler_not_configured, [atom()]}}
  def load(overrides \\ %{}) do
    config =
      :symphony_elixir
      |> Application.get_env(:aws_task_scheduler, [])
      |> Enum.into(%{})
      |> Map.merge(normalize_keys(overrides))
      |> put_env_defaults()

    missing =
      @required
      |> Enum.reject(fn key -> present?(Map.get(config, key)) end)

    if missing == [] do
      {:ok, normalize(config)}
    else
      {:error, {:aws_scheduler_not_configured, missing}}
    end
  end

  defp put_env_defaults(config) do
    config
    |> put_default(:region, env("AWS_REGION") || env("AWS_DEFAULT_REGION"))
    |> put_default(:cluster, env("AWS_ECS_CLUSTER"))
    |> put_default(:task_definition, env("AWS_ECS_TASK_DEFINITION"))
    |> put_default(:subnets, split_env("AWS_ECS_SUBNETS"))
    |> put_default(:security_groups, split_env("AWS_ECS_SECURITY_GROUPS"))
    |> put_default(:container_name, env("AWS_ECS_CONTAINER_NAME"))
    |> put_default(:assign_public_ip, env("AWS_ECS_ASSIGN_PUBLIC_IP") || "DISABLED")
    |> put_default(:launch_type, env("AWS_ECS_LAUNCH_TYPE") || "FARGATE")
    |> put_default(:platform_version, env("AWS_ECS_PLATFORM_VERSION"))
    |> put_default(:task_store_path, env("AWS_ECS_TASK_STORE_PATH") || default_store_path())
  end

  defp put_default(config, _key, nil), do: config
  defp put_default(config, _key, []), do: config

  defp put_default(config, key, value) do
    case Map.get(config, key) do
      nil -> Map.put(config, key, value)
      "" -> Map.put(config, key, value)
      [] -> Map.put(config, key, value)
      _present -> config
    end
  end

  defp normalize(config) do
    %{
      region: Map.fetch!(config, :region),
      cluster: Map.fetch!(config, :cluster),
      task_definition: Map.fetch!(config, :task_definition),
      subnets: normalize_list(Map.fetch!(config, :subnets)),
      security_groups: normalize_list(Map.get(config, :security_groups, [])),
      container_name: blank_to_nil(Map.get(config, :container_name)),
      assign_public_ip: Map.get(config, :assign_public_ip, "DISABLED"),
      launch_type: Map.get(config, :launch_type, "FARGATE"),
      platform_version: blank_to_nil(Map.get(config, :platform_version)),
      task_store_path: Map.get(config, :task_store_path, default_store_path())
    }
  end

  defp normalize_keys(value) when is_map(value) do
    Map.new(value, fn {key, value} -> {normalize_key(key), value} end)
  end

  defp normalize_keys(value) when is_list(value), do: value |> Enum.into(%{}) |> normalize_keys()

  defp normalize_key(key) when is_atom(key), do: key

  defp normalize_key(key) when is_binary(key) do
    key
    |> Macro.underscore()
    |> String.to_atom()
  end

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(value) when is_list(value), do: value != []
  defp present?(nil), do: false
  defp present?(_value), do: true

  defp normalize_list(value) when is_list(value), do: Enum.reject(value, &(to_string(&1) == ""))

  defp normalize_list(value) when is_binary(value) do
    value
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  defp normalize_list(_value), do: []

  defp split_env(name) do
    case env(name) do
      nil -> []
      value -> normalize_list(value)
    end
  end

  defp blank_to_nil(value) when value in [nil, ""], do: nil
  defp blank_to_nil(value), do: value

  defp env(name), do: System.get_env(name)

  defp default_store_path do
    Path.join(System.tmp_dir!(), "parallel-agent-runtime-aws-tasks.json")
  end
end
