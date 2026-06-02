defmodule SymphonyElixir.Launcher.EngineInstanceSync do
  @moduledoc """
  Coordinates launcher lifecycle state with the `engine_instance` table.

  This module owns the boundary between the launcher GenServer and Supabase:
  it filters entries that can be persisted, dispatches slow I/O away from the
  caller, and logs failed writeback/reconcile attempts.
  """

  require Logger

  alias SymphonyElixir.Launcher.EngineInstance
  alias SymphonyElixir.Launcher.LifecycleLog
  alias SymphonyElixir.RuntimeLog

  @running_statuses [:running, :healthy]
  @stale_db_statuses ["running", "healthy", "draining", "starting"]

  @doc """
  Host identifier used for runtime logging and engine_instance rows.
  """
  @spec host() :: String.t()
  def host, do: EngineInstance.host()

  @doc """
  Upsert a row for an entry that represents a stored agent.

  Legacy `start_orchestrator` entries do not include agent/workspace foreign
  keys, so they are ignored.
  """
  @spec record_state(map(), EngineInstance.status()) :: :ok
  def record_state(%{agent_id: agent_id, workspace_id: workspace_id} = entry, status)
      when is_binary(agent_id) and is_binary(workspace_id) do
    attrs = %{
      instance_id: entry.id,
      agent_id: agent_id,
      workspace_id: workspace_id,
      host: EngineInstance.host(),
      port: entry.port,
      status: status,
      started_at: entry.started_at
    }

    dispatch(fn -> EngineInstance.upsert(attrs) end, "upsert", entry)
  end

  def record_state(_entry, _status), do: :ok

  @doc """
  Update the persisted status for an entry that represents a stored agent.
  """
  @spec update_status(map(), EngineInstance.status()) :: :ok
  def update_status(%{id: id, agent_id: agent_id, workspace_id: workspace_id}, status)
      when is_binary(agent_id) and is_binary(workspace_id) do
    dispatch(
      fn -> EngineInstance.update_status(id, status) end,
      "status",
      %{id: id, agent_id: agent_id, workspace_id: workspace_id, desired_state: status}
    )
  end

  def update_status(_entry, _status), do: :ok

  @doc """
  Emit heartbeats for running persisted orchestrators.
  """
  @spec emit_heartbeats(map()) :: :ok
  def emit_heartbeats(orchestrators) when is_map(orchestrators) do
    if EngineInstance.enabled?() do
      Enum.each(orchestrators, fn {_id, entry} ->
        case entry do
          %{id: id, agent_id: agent_id, workspace_id: workspace_id, status: status}
          when status in @running_statuses and
                 is_binary(agent_id) and is_binary(workspace_id) ->
            dispatch(fn -> EngineInstance.heartbeat(id) end, "heartbeat", entry)

          _ ->
            :ok
        end
      end)
    end

    :ok
  end

  @doc """
  Reconcile rows owned by this host against the launcher's supervised entries.

  The Supabase read and follow-up writes are dispatched together so startup
  never blocks on a slow or unavailable database.
  """
  @spec reconcile_async(map()) :: :ok
  def reconcile_async(orchestrators) when is_map(orchestrators) do
    known_ids = orchestrators |> Map.keys() |> MapSet.new()
    host = EngineInstance.host()

    dispatch(fn -> reconcile(host, known_ids) end)
  end

  @doc false
  @spec reconcile(String.t(), MapSet.t()) :: :ok
  def reconcile(host, known_ids) when is_binary(host) do
    case EngineInstance.list_by_host(host) do
      {:ok, rows} ->
        Enum.each(rows, &reconcile_row(&1, host, known_ids))

      :disabled ->
        :ok

      {:error, reason} ->
        Logger.warning("Launcher engine_instance reconcile failed: #{inspect(reason)}")

        LifecycleLog.log_failure(
          :warning,
          :engine_instance_reconcile_failed,
          %{host: host},
          nil,
          reason,
          operation: :engine_reconcile
        )
    end

    :ok
  end

  defp reconcile_row(row, host, known_ids) do
    instance_id = Map.get(row, "instance_id")
    row_status = Map.get(row, "status")

    cond do
      not is_binary(instance_id) ->
        :ok

      MapSet.member?(known_ids, instance_id) ->
        # This process supervises the id. Mark it running so the DB reflects
        # the live process, even if the previous launcher left it starting.
        reconcile_status(instance_id, :running, host, "running", %{
          run_id: instance_id,
          host: host,
          desired_state: :running,
          actual_state: :failed
        })

      row_status in @stale_db_statuses ->
        Logger.warning("engine_instance row #{instance_id} on host #{host} is #{row_status} but no supervised process exists; marking failed")

        reconcile_status(instance_id, :failed, host, "failed", %{
          run_id: instance_id,
          host: host,
          desired_state: :failed,
          actual_state: row_status
        })

      true ->
        :ok
    end
  end

  defp reconcile_status(instance_id, status, host, label, failure_fields) do
    case EngineInstance.update_status(instance_id, status) do
      :ok ->
        :ok

      :disabled ->
        :ok

      {:error, reason} ->
        Logger.warning("Launcher engine_instance reconcile-#{label} for #{instance_id} failed: #{inspect(reason)}")

        LifecycleLog.log_failure(
          :warning,
          :engine_instance_reconcile_failed,
          Map.put_new(failure_fields, :host, host),
          nil,
          reason,
          operation: :engine_reconcile
        )
    end
  end

  defp dispatch(work) when is_function(work, 0) do
    dispatcher().(fn ->
      RuntimeLog.with_operation_trace_id(nil, work)
    end)

    :ok
  end

  defp dispatch(work, label, entry_or_id) when is_function(work, 0) do
    trace_id = Process.get(:symphony_trace_id)

    dispatcher().(fn ->
      RuntimeLog.with_operation_trace_id(trace_id, fn ->
        case work.() do
          :ok ->
            :ok

          :disabled ->
            :ok

          {:error, reason} ->
            instance_id = if is_map(entry_or_id), do: Map.get(entry_or_id, :id), else: entry_or_id
            Logger.warning("Launcher engine_instance #{label} for #{instance_id} failed: #{inspect(reason)}")

            LifecycleLog.log_failure(
              :warning,
              :"engine_instance_#{label}_failed",
              entry_or_id,
              nil,
              reason,
              operation: :engine_instance
            )
        end
      end)
    end)

    :ok
  end

  defp dispatcher do
    Application.get_env(:symphony_elixir, :launcher_engine_instance_dispatcher, &async_dispatch/1)
  end

  defp async_dispatch(work) when is_function(work, 0) do
    {:ok, _pid} = Task.start(work)
    :ok
  end
end
