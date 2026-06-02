defmodule SymphonyElixir.ScheduledTask.Repository do
  @moduledoc """
  PostgREST repository for scheduled task clock and tool operations.
  """

  alias SymphonyElixir.{MapUtils, PostgRESTClient, Supabase, SupabaseSchema}

  @task_table "scheduled_task"
  @run_table "scheduled_task_run"
  @agent_table "agent"
  @required_task_columns ~w(
    id
    workspace_id
    agent_id
    source_work_item_id
    instructions
    enabled
    schedule
    timezone
    next_run_at
    delivery
    metadata
  )
  @required_run_columns ~w(
    id
    scheduled_task_id
    workspace_id
    agent_id
    scheduled_for
    status
    started_at
    finished_at
    run_id
    source_work_item_id
    error
    attempt_count
  )

  @spec due_tasks(DateTime.t(), pos_integer(), keyword()) :: {:ok, [map()]} | {:error, term()}
  def due_tasks(%DateTime{} = now, limit, opts \\ []) when is_integer(limit) and limit > 0 do
    with {:ok, client} <- client(opts) do
      query = %{
        "enabled" => "eq.true",
        "next_run_at" => "lte.#{DateTime.to_iso8601(now)}",
        "order" => "next_run_at.asc",
        "limit" => Integer.to_string(limit)
      }

      get(client, task_table(opts), query, "scheduled_task.due_tasks")
    end
  end

  @spec claim_run(map(), DateTime.t(), DateTime.t(), keyword()) ::
          {:ok, map() | :conflict} | {:error, term()}
  def claim_run(task, scheduled_for, started_at, opts \\ []) do
    with {:ok, client} <- client(opts),
         {:ok, task_id} <- required_string(task, "id"),
         {:ok, agent_id} <- required_string(task, "agent_id") do
      payload =
        %{
          "scheduled_task_id" => task_id,
          "agent_id" => agent_id,
          "scheduled_for" => DateTime.to_iso8601(scheduled_for),
          "status" => "claimed",
          "started_at" => DateTime.to_iso8601(started_at),
          "attempt_count" => 1
        }
        |> MapUtils.put_present("workspace_id", string_value(task, "workspace_id"))
        |> MapUtils.put_present("source_work_item_id", string_value(task, "source_work_item_id"))

      case PostgRESTClient.upsert(
             client,
             run_table(opts),
             payload,
             ["scheduled_task_id", "scheduled_for"],
             prefer: "resolution=ignore-duplicates,return=representation",
             log_metadata: log_metadata("scheduled_task.claim_run")
           ) do
        {:ok, [row | _]} when is_map(row) -> {:ok, row}
        {:ok, []} -> {:ok, :conflict}
        {:ok, _other} -> {:error, :invalid_claim_response}
        {:error, _reason} = error -> error
      end
    end
  end

  @spec finish_run(String.t(), map(), keyword()) :: {:ok, map() | nil} | {:error, term()}
  def finish_run(run_id, payload, opts \\ []) when is_binary(run_id) and is_map(payload) do
    update_by_id(run_table(opts), run_id, payload, opts, "scheduled_task.finish_run")
  end

  @spec update_task(String.t(), map(), keyword()) :: {:ok, map() | nil} | {:error, term()}
  def update_task(task_id, payload, opts \\ []) when is_binary(task_id) and is_map(payload) do
    query =
      %{"id" => "eq.#{task_id}", "order" => "id", "limit" => "1"}
      |> MapUtils.put_present("updated_at", eq_value(Keyword.get(opts, :match_updated_at)))

    update(task_table(opts), query, payload, opts, "scheduled_task.update_task")
  end

  @spec create_task(map(), keyword()) :: {:ok, map() | nil} | {:error, term()}
  def create_task(payload, opts \\ []) when is_map(payload) do
    with {:ok, client} <- client(opts) do
      case PostgRESTClient.post(client, task_table(opts), payload,
             prefer: "return=representation",
             log_metadata: log_metadata("scheduled_task.create_task")
           ) do
        {:ok, rows} -> {:ok, row_result(rows)}
        {:error, _reason} = error -> error
      end
    end
  end

  @spec read_task(String.t(), String.t(), keyword()) :: {:ok, map() | nil} | {:error, term()}
  def read_task(task_id, workspace_id, opts \\ []) do
    query = %{"id" => "eq.#{task_id}", "workspace_id" => "eq.#{workspace_id}", "limit" => "1"}

    with {:ok, client} <- client(opts) do
      case get(client, task_table(opts), query, "scheduled_task.read_task") do
        {:ok, rows} -> {:ok, row_result(rows)}
        {:error, _reason} = error -> error
      end
    end
  end

  @spec list_tasks(String.t(), keyword()) :: {:ok, [map()]} | {:error, term()}
  def list_tasks(workspace_id, opts \\ []) do
    query = %{"workspace_id" => "eq.#{workspace_id}", "order" => "next_run_at.asc.nullslast"}

    with {:ok, client} <- client(opts) do
      get(client, task_table(opts), query, "scheduled_task.list_tasks")
    end
  end

  @spec agent_workspace_id(String.t(), keyword()) :: {:ok, String.t()} | {:error, term()}
  def agent_workspace_id(agent_id, opts \\ [])

  def agent_workspace_id(agent_id, opts) when is_binary(agent_id) and agent_id != "" do
    query = %{"id" => "eq.#{agent_id}", "select" => "workspace_id", "limit" => "2"}

    with {:ok, client} <- client(opts) do
      case get(client, agent_table(opts), query, "scheduled_task.agent_workspace_id") do
        {:ok, [%{"workspace_id" => workspace_id}]}
        when is_binary(workspace_id) and workspace_id != "" ->
          {:ok, workspace_id}

        {:ok, []} ->
          {:error, :missing_workspace_context}

        {:ok, _rows} ->
          {:error, :ambiguous_workspace_context}

        {:error, _reason} = error ->
          error
      end
    end
  end

  def agent_workspace_id(_agent_id, _opts), do: {:error, :missing_workspace_context}

  @doc false
  def req_options,
    do: Application.get_env(:symphony_elixir, :scheduled_task_repository_req_options, [])

  @doc false
  def configured? do
    match?({:ok, _}, Supabase.rest_endpoint()) and match?({:ok, _}, Supabase.service_role_key())
  end

  @doc false
  @spec schema_ready?() :: boolean()
  def schema_ready? do
    Enum.all?(@required_task_columns, &SupabaseSchema.column?(@task_table, &1)) and
      Enum.all?(@required_run_columns, &SupabaseSchema.column?(@run_table, &1))
  end

  @doc false
  @spec schema_error() :: {:scheduled_task_schema_not_ready, map()}
  def schema_error do
    {:scheduled_task_schema_not_ready,
     %{
       scheduled_task: missing_columns(@task_table, @required_task_columns),
       scheduled_task_run: missing_columns(@run_table, @required_run_columns)
     }}
  end

  defp missing_columns(table, columns) do
    Enum.reject(columns, &SupabaseSchema.column?(table, &1))
  end

  defp update_by_id(table, id, payload, opts, caller) do
    update(table, %{"id" => "eq.#{id}", "order" => "id", "limit" => "1"}, payload, opts, caller)
  end

  defp update(table, query, payload, opts, caller) do
    with {:ok, client} <- client(opts) do
      case PostgRESTClient.patch(client, table, query, payload,
             prefer: "return=representation",
             log_metadata: log_metadata(caller)
           ) do
        {:ok, rows} -> {:ok, row_result(rows)}
        {:error, _reason} = error -> error
      end
    end
  end

  defp get(client, table, query, caller) do
    case PostgRESTClient.get(client, table, query, log_metadata: log_metadata(caller)) do
      {:ok, rows} when is_list(rows) -> {:ok, rows}
      {:ok, _body} -> {:error, :invalid_response}
      {:error, _reason} = error -> error
    end
  end

  defp client(opts) do
    config =
      Application.get_env(:symphony_elixir, :scheduled_task_repository, [])
      |> normalize_config()
      |> Map.merge(normalize_config(Keyword.get(opts, :config, [])))

    {:ok, PostgRESTClient.new(config, Keyword.get(opts, :req_options, req_options()))}
  rescue
    error in ArgumentError -> {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp task_table(opts), do: table(opts, :task_table, @task_table)
  defp run_table(opts), do: table(opts, :run_table, @run_table)
  defp agent_table(opts), do: table(opts, :agent_table, @agent_table)

  defp table(opts, key, default) do
    opts_config = normalize_config(Keyword.get(opts, :config, []))

    app_config =
      normalize_config(Application.get_env(:symphony_elixir, :scheduled_task_repository, []))

    Map.get(opts_config, key) || Map.get(app_config, key) || default
  end

  defp normalize_config(nil), do: %{}
  defp normalize_config(config) when is_list(config), do: Map.new(config)
  defp normalize_config(config) when is_map(config), do: config

  defp row_result([row | _]) when is_map(row), do: row
  defp row_result([]), do: nil
  defp row_result(row) when is_map(row), do: row
  defp row_result(other), do: other

  defp required_string(map, key) do
    case string_value(map, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_field, key}}
    end
  end

  defp string_value(map, key), do: MapUtils.atom_or_string_get(map, key)
  defp eq_value(value) when is_binary(value) and value != "", do: "eq.#{value}"
  defp eq_value(_value), do: nil
  defp log_metadata(caller), do: %{caller: caller, action: caller}
end
