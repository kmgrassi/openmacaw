defmodule SymphonyElixir.CloudExecution.Aws.TaskScheduler do
  @moduledoc """
  ECS/Fargate task lifecycle scheduler for cloud execution smoke paths.
  """

  alias SymphonyElixir.CloudExecution.Aws.Config
  alias SymphonyElixir.CloudExecution.Aws.EcsClient
  alias SymphonyElixir.CloudExecution.Aws.TaskRecord
  alias SymphonyElixir.CloudExecution.Aws.TaskStore

  @runtime_tag "parallel-agent-runtime"
  @poll_interval_ms 1_000
  @poll_timeout_ms 300_000

  @type launch_attrs :: %{
          optional(:workspace_id) => String.t(),
          optional(:session_id) => String.t(),
          optional(:run_id) => String.t(),
          optional(:timeout_seconds) => pos_integer(),
          optional(:command) => [String.t()],
          optional(:environment) => map()
        }

  @spec launch(launch_attrs(), keyword()) :: {:ok, TaskRecord.t()} | {:error, term()}
  def launch(attrs, opts \\ []) when is_map(attrs) do
    with {:ok, config} <- load_config(opts),
         {:ok, response} <- client(opts).run_task(config, run_task_payload(config, attrs)) do
      case Map.get(response, "failures", []) do
        [] ->
          task = response |> Map.fetch!("tasks") |> List.first()
          record = TaskRecord.new(Map.put(attrs, :cluster, config.cluster), task)
          :ok = TaskStore.upsert(record, store(opts))
          {:ok, record}

        failures ->
          {:error, {:aws_ecs_launch_failed, failures}}
      end
    end
  end

  @spec wait(String.t(), keyword()) :: {:ok, TaskRecord.t()} | {:error, term()}
  def wait(task_arn, opts \\ []) do
    deadline = System.monotonic_time(:millisecond) + Keyword.get(opts, :poll_timeout_ms, @poll_timeout_ms)
    poll_until_terminal(task_arn, deadline, opts)
  end

  @spec stop(String.t(), String.t(), keyword()) :: {:ok, TaskRecord.t()} | {:error, term()}
  def stop(task_arn, reason \\ "runtime cancellation", opts \\ []) do
    with {:ok, config} <- load_config(opts),
         {:ok, response} <- client(opts).stop_task(config, task_arn, reason) do
      task = Map.get(response, "task", %{"taskArn" => task_arn, "lastStatus" => "STOPPED"})
      record = upsert_described_task(task, opts)
      {:ok, record}
    end
  end

  @spec reconcile(keyword()) :: {:ok, [TaskRecord.t()]} | {:error, term()}
  def reconcile(opts \\ []) do
    with {:ok, config} <- load_config(opts),
         {:ok, running_arns} <- list_running_task_arns(config, opts),
         {:ok, described_running} <- describe_task_arns(config, running_arns, opts),
         {:ok, described_known} <- describe_known_non_terminal(config, opts) do
      records =
        (described_running ++ described_known)
        |> Enum.filter(&owned_task?/1)
        |> Enum.map(&upsert_described_task(&1, opts))

      {:ok, records}
    end
  end

  @spec launch_and_wait(launch_attrs(), keyword()) :: {:ok, TaskRecord.t()} | {:error, term()}
  def launch_and_wait(attrs, opts \\ []) do
    with {:ok, record} <- launch(attrs, opts) do
      wait(record.task_arn, opts)
    end
  end

  defp poll_until_terminal(task_arn, deadline, opts) do
    with {:ok, config} <- load_config(opts),
         {:ok, task} <- describe_one_task(config, task_arn, opts) do
      record = upsert_described_task(task, opts)

      cond do
        TaskRecord.terminal?(record) ->
          {:ok, record}

        timeout_expired?(record) ->
          stop(task_arn, "runtime timeout", opts)

        System.monotonic_time(:millisecond) >= deadline ->
          stop(task_arn, "runtime poll timeout", opts)

        true ->
          Process.sleep(Keyword.get(opts, :poll_interval_ms, @poll_interval_ms))
          poll_until_terminal(task_arn, deadline, opts)
      end
    end
  end

  defp describe_known_non_terminal(config, opts) do
    task_arns =
      TaskStore.non_terminal(store(opts))
      |> Enum.map(& &1.task_arn)
      |> Enum.reject(&is_nil/1)

    describe_task_arns(config, task_arns, opts)
  end

  defp describe_task_arns(_config, [], _opts), do: {:ok, []}

  defp describe_task_arns(config, task_arns, opts) do
    with {:ok, response} <- client(opts).describe_tasks(config, task_arns) do
      {:ok, Map.get(response, "tasks", [])}
    end
  end

  defp describe_one_task(config, task_arn, opts) do
    with {:ok, response} <- client(opts).describe_tasks(config, [task_arn]) do
      case Map.get(response, "tasks", []) do
        [task] ->
          {:ok, task}

        [] ->
          {:error, {:aws_ecs_task_not_found, task_arn, Map.get(response, "failures", [])}}

        tasks ->
          {:error, {:aws_ecs_unexpected_task_count, task_arn, length(tasks)}}
      end
    end
  end

  defp list_running_task_arns(config, opts), do: list_running_task_arns(config, nil, [], opts)

  defp list_running_task_arns(config, next_token, acc, opts) do
    with {:ok, response} <- client(opts).list_tasks(config, desired_status: "RUNNING", next_token: next_token) do
      arns = Map.get(response, "taskArns", [])

      case Map.get(response, "nextToken") do
        nil -> {:ok, acc ++ arns}
        token -> list_running_task_arns(config, token, acc ++ arns, opts)
      end
    end
  end

  defp upsert_described_task(task, opts) do
    task_store = store(opts)
    existing = TaskStore.get(Map.get(task, "taskArn"), task_store)

    record =
      case existing do
        %TaskRecord{} = record ->
          TaskRecord.merge_task(record, task)

        nil ->
          attrs =
            task
            |> ownership_tag_map()
            |> Map.put(:cluster, cluster_from_opts(opts))

          TaskRecord.new(attrs, task)
      end

    :ok = TaskStore.upsert(record, task_store)
    record
  end

  defp run_task_payload(config, attrs) do
    %{
      "cluster" => config.cluster,
      "taskDefinition" => config.task_definition,
      "launchType" => config.launch_type,
      "networkConfiguration" => network_configuration(config),
      "tags" => ownership_tag_list(attrs)
    }
    |> maybe_put("platformVersion", config.platform_version)
    |> maybe_put("overrides", overrides(config, attrs))
  end

  defp network_configuration(config) do
    %{
      "awsvpcConfiguration" =>
        %{
          "subnets" => config.subnets,
          "assignPublicIp" => config.assign_public_ip
        }
        |> maybe_put("securityGroups", non_empty(config.security_groups))
    }
  end

  defp overrides(config, attrs) do
    container_override =
      %{"name" => config.container_name}
      |> maybe_put("command", Map.get(attrs, :command) || Map.get(attrs, "command"))
      |> maybe_put("environment", environment(attrs))

    if config.container_name do
      %{"containerOverrides" => [container_override]}
    else
      nil
    end
  end

  defp environment(attrs) do
    env = Map.get(attrs, :environment) || Map.get(attrs, "environment") || %{}

    if map_size(env) == 0 do
      nil
    else
      Enum.map(env, fn {key, value} -> %{"name" => to_string(key), "value" => to_string(value)} end)
    end
  end

  defp ownership_tag_list(attrs) do
    [
      %{"key" => "runtime", "value" => @runtime_tag},
      tag("workspace_id", Map.get(attrs, :workspace_id) || Map.get(attrs, "workspace_id")),
      tag("session_id", Map.get(attrs, :session_id) || Map.get(attrs, "session_id")),
      tag("run_id", Map.get(attrs, :run_id) || Map.get(attrs, "run_id"))
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp ownership_tag_map(task) do
    task
    |> Map.get("tags", [])
    |> Map.new(fn %{"key" => key, "value" => value} -> {tag_key(key), value} end)
  end

  defp owned_task?(task) do
    task
    |> Map.get("tags", [])
    |> Enum.any?(fn
      %{"key" => "runtime", "value" => @runtime_tag} -> true
      _other -> false
    end)
  end

  defp tag(_key, nil), do: nil
  defp tag(_key, ""), do: nil
  defp tag(key, value), do: %{"key" => key, "value" => to_string(value)}

  defp tag_key("workspace_id"), do: :workspace_id
  defp tag_key("session_id"), do: :session_id
  defp tag_key("run_id"), do: :run_id
  defp tag_key(_key), do: :ignored_tag

  defp timeout_expired?(%TaskRecord{timeout_at: nil}), do: false

  defp timeout_expired?(%TaskRecord{timeout_at: timeout_at}) do
    case DateTime.from_iso8601(timeout_at) do
      {:ok, datetime, _offset} -> DateTime.compare(DateTime.utc_now(), datetime) != :lt
      _error -> false
    end
  end

  defp load_config(opts), do: Config.load(Keyword.get(opts, :config, %{}))

  defp client(opts) do
    Keyword.get(opts, :client) ||
      Application.get_env(:symphony_elixir, :aws_ecs_client, EcsClient)
  end

  defp store(opts) do
    Keyword.get(opts, :store) ||
      Application.get_env(:symphony_elixir, :aws_task_store, TaskStore)
  end

  defp cluster_from_opts(opts) do
    case load_config(opts) do
      {:ok, config} -> config.cluster
      {:error, _reason} -> nil
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, _key, []), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp non_empty([]), do: nil
  defp non_empty(value), do: value
end
