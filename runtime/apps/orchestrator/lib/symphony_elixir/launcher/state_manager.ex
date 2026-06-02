defmodule SymphonyElixir.Launcher.StateManager do
  @moduledoc """
  Persists `SymphonyElixir.Launcher.Server` state to disk and restores it on
  startup.

  The launcher needs to survive restarts: when the BEAM comes back up, every
  orchestrator that was running before should be re-launched on the same port
  with the same config. This module owns the JSON file format and the restore
  loop. The actual orchestrator process is started via a callback so this
  module stays decoupled from the dynamic supervisor.

  ## File format

      {
        "next_port": 4002,
        "orchestrators": [
          {
            "id": "orch_abc123",
            "port": 4000,
            "config": { ... },
            "agent_id": "agent-1",
            "type": "manager",
            "agent_name": "...",
            "workspace_id": "...",
            "project_id": "..."
          }
        ]
      }
  """

  require Logger

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Launcher.LifecycleLog

  @file_name "orchestrators.json"

  @type start_fn :: (String.t(), non_neg_integer(), map() -> {:ok, pid()} | {:error, term()})
  @type on_started :: (map() -> any())

  @spec persist(map()) :: :ok | {:error, term()}
  def persist(%{state_dir: state_dir, orchestrators: orchestrators, next_port: next_port}) do
    data = %{
      next_port: next_port,
      orchestrators:
        Enum.map(orchestrators, fn {id, entry} ->
          %{
            id: id,
            port: entry.port,
            config: entry.config,
            agent_id: Map.get(entry, :agent_id),
            type: Map.get(entry, :type),
            agent_name: Map.get(entry, :agent_name),
            workspace_id: Map.get(entry, :workspace_id),
            project_id: Map.get(entry, :project_id),
            restart_count: Map.get(entry, :restart_count, 0)
          }
        end)
    }

    path = Path.join(state_dir, @file_name)

    started_at = System.monotonic_time(:millisecond)

    case Jason.encode(data, pretty: true) do
      {:ok, json} ->
        case File.write(path, json) do
          :ok ->
            :ok

          {:error, reason} = error ->
            Logger.error("Failed to persist launcher state: #{inspect(reason)}")

            LifecycleLog.log_failure(
              :error,
              :launcher_state_file_write_failed,
              %{state_file_path: path},
              started_at,
              reason,
              operation: :state_write
            )

            error
        end

      {:error, reason} ->
        Logger.error("Failed to persist launcher state: #{inspect(reason)}")

        LifecycleLog.log_failure(
          :error,
          :launcher_state_file_write_failed,
          %{state_file_path: path},
          started_at,
          reason,
          operation: :state_write
        )

        {:error, reason}
    end
  end

  @doc """
  Reads the persisted state file and replays each saved orchestrator via
  `start_fn`. `on_started` runs once per successful restart so the caller can
  monitor the new pid and write engine_instance rows.

  Returns the updated `state` map. The caller's `state.next_port` is advanced
  past every restored port.
  """
  @spec restore(map(), start_fn(), on_started()) :: map()
  def restore(%{state_dir: state_dir} = state, start_fn, on_started)
      when is_function(start_fn, 3) and is_function(on_started, 1) do
    path = Path.join(state_dir, @file_name)

    started_at = System.monotonic_time(:millisecond)

    case File.read(path) do
      {:ok, content} ->
        case Jason.decode(content) do
          {:ok, %{"orchestrators" => saved_orchs, "next_port" => next_port}} ->
            state = %{state | next_port: next_port}
            restart_saved_orchestrators(state, saved_orchs, start_fn, on_started)

          {:ok, %{"orchestrators" => saved_orchs}} ->
            restart_saved_orchestrators(state, saved_orchs, start_fn, on_started)

          _ ->
            Logger.warning("Corrupt launcher state file, starting fresh")

            LifecycleLog.log_failure(
              :warning,
              :launcher_state_file_read_failed,
              %{state_file_path: path},
              started_at,
              :corrupt_json,
              operation: :state_read
            )

            state
        end

      {:error, :enoent} ->
        state

      {:error, reason} ->
        Logger.warning("Failed to read launcher state: #{inspect(reason)}")

        LifecycleLog.log_failure(
          :warning,
          :launcher_state_file_read_failed,
          %{state_file_path: path},
          started_at,
          reason,
          operation: :state_read
        )

        state
    end
  end

  defp restart_saved_orchestrators(state, saved_orchs, start_fn, on_started) do
    Enum.reduce(saved_orchs, state, fn saved, acc ->
      id = saved["id"]
      port = saved["port"]
      config = saved["config"]

      case start_fn.(id, port, config) do
        {:ok, pid} ->
          entry = %{
            id: id,
            pid: pid,
            ref: nil,
            port: port,
            config: config,
            started_at: DateTime.utc_now(),
            status: :running,
            agent_id: saved["agent_id"],
            type: restored_agent_type(saved),
            agent_name: saved["agent_name"],
            workspace_id: saved["workspace_id"],
            project_id: saved["project_id"],
            restart_count: saved["restart_count"] || 0
          }

          entry = on_started.(entry) || entry

          new_next_port = max(acc.next_port, port + 1)

          %{
            acc
            | orchestrators: Map.put(acc.orchestrators, id, entry),
              next_port: new_next_port
          }

        {:error, reason} ->
          Logger.error("Failed to restore orchestrator #{id}: #{inspect(reason)}")

          LifecycleLog.log_failure(
            :error,
            :launcher_restore_failed,
            %{run_id: id, port: port, desired_state: :running, actual_state: :failed},
            System.monotonic_time(:millisecond),
            reason,
            operation: :start
          )

          acc
      end
    end)
  end

  defp restored_agent_type(%{"agent_id" => agent_id} = saved)
       when is_binary(agent_id) and agent_id != "" do
    saved
    |> Map.get("type")
    |> Agent.kind()
  end

  defp restored_agent_type(_saved), do: nil
end
