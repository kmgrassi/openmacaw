defmodule SymphonyElixir.Launcher.LifecycleLog do
  @moduledoc """
  Structured launcher lifecycle logging and latest-failure summaries.

  The launcher writes some failures from async tasks, so the latest summary
  lives in ETS instead of only in `SymphonyElixir.Launcher.Server` state.
  """

  alias SymphonyElixir.RuntimeLog

  @table :symphony_launcher_failure_summary

  @type failure_source ::
          :port_allocation
          | :process_spawn
          | :health_check
          | :database_heartbeat
          | :config_resolution
          | :runtime_crash
          | :state_file
          | :unknown

  @spec start_fields(map(), map()) :: map()
  def start_fields(entry_or_fields, extra \\ %{}) do
    entry_or_fields
    |> base_fields()
    |> Map.merge(extra)
  end

  @spec completion_fields(map(), integer(), map()) :: map()
  def completion_fields(entry_or_fields, started_at, extra \\ %{}) do
    entry_or_fields
    |> start_fields(extra)
    |> Map.put(:duration_ms, duration_ms(started_at))
  end

  @spec log_failure(Logger.level(), String.t() | atom(), map(), integer() | nil, term(), keyword()) :: map()
  def log_failure(level, event, entry_or_fields, started_at, reason, extra \\ []) do
    fields = failure_fields(entry_or_fields, started_at, reason, Map.new(extra))
    RuntimeLog.log(level, event, fields)
    record_failure(event, fields)
  end

  @spec failure_fields(map(), integer() | nil, term(), map()) :: map()
  def failure_fields(entry_or_fields, started_at, reason, extra \\ %{}) do
    source = Map.get(extra, :failure_source) || classify_failure(reason, Map.get(extra, :operation))

    entry_or_fields
    |> start_fields(extra)
    |> Map.put(:duration_ms, if(started_at, do: duration_ms(started_at)))
    |> Map.put(:error_code, error_code(source))
    |> Map.put(:failure_source, source)
    |> Map.put(:retryable, retryable?(source))
    |> Map.put(:reason, inspect(reason))
    |> drop_nil_values()
  end

  @spec record_failure(String.t() | atom(), map()) :: map()
  def record_failure(event, fields) when is_map(fields) do
    summary =
      fields
      |> Map.take([
        :trace_id,
        :run_id,
        :agent_id,
        :workspace_id,
        :host,
        :port,
        :desired_state,
        :actual_state,
        :restart_count,
        :failure_source,
        :error_code,
        :retryable,
        :reason
      ])
      |> Map.put(:event, normalize_event(event))
      |> Map.put(:timestamp, DateTime.utc_now() |> DateTime.to_iso8601())
      |> drop_nil_values()

    summary = encode_safe(summary)

    table()
    :ets.insert(@table, {:latest_failure, summary})
    summary
  end

  @spec latest_failure() :: map() | nil
  def latest_failure do
    case :ets.lookup(table(), :latest_failure) do
      [{:latest_failure, summary}] -> summary
      [] -> nil
    end
  end

  @spec reset() :: :ok
  def reset do
    table()
    :ets.delete(@table, :latest_failure)
    :ok
  end

  @spec classify_failure(term(), atom() | nil) :: failure_source()
  def classify_failure(reason, operation \\ nil)
  def classify_failure(_reason, :config_resolution), do: :config_resolution
  def classify_failure(_reason, :state_read), do: :state_file
  def classify_failure(_reason, :state_write), do: :state_file
  def classify_failure({:invalid_agent_config, _, _}, _operation), do: :config_resolution
  def classify_failure({:missing_execution_profile_field, _}, _operation), do: :config_resolution
  def classify_failure({:unsupported_execution_profile_runner, _}, _operation), do: :config_resolution
  def classify_failure({:unsupported_execution_profile_provider, _}, _operation), do: :config_resolution
  def classify_failure({:invalid_execution_profile_field, _}, _operation), do: :config_resolution
  def classify_failure(:eaddrinuse, _operation), do: :port_allocation
  def classify_failure({:shutdown, :eaddrinuse}, _operation), do: :port_allocation
  def classify_failure({:already_started, _pid}, _operation), do: :port_allocation
  def classify_failure({:health_check_failed, _}, _operation), do: :health_check
  def classify_failure(:timeout, _operation), do: :health_check
  def classify_failure({:timeout, _}, _operation), do: :health_check
  def classify_failure(_reason, :engine_instance), do: :database_heartbeat
  def classify_failure(_reason, :engine_reconcile), do: :database_heartbeat
  def classify_failure({:error, reason}, operation), do: classify_failure(reason, operation)
  def classify_failure(_reason, :runtime_crash), do: :runtime_crash
  def classify_failure(reason, _operation) when reason in [:killed, :kill, :normal], do: :runtime_crash
  def classify_failure(_reason, :restart), do: :process_spawn
  def classify_failure(_reason, :start), do: :process_spawn
  def classify_failure(_reason, _operation), do: :unknown

  defp error_code(:port_allocation), do: "launcher_port_allocation_failed"
  defp error_code(:process_spawn), do: "launcher_process_spawn_failed"
  defp error_code(:health_check), do: "launcher_health_check_failed"
  defp error_code(:database_heartbeat), do: "launcher_database_heartbeat_failed"
  defp error_code(:config_resolution), do: "launcher_config_resolution_failed"
  defp error_code(:runtime_crash), do: "launcher_runtime_crash"
  defp error_code(:state_file), do: "launcher_state_file_failed"
  defp error_code(:unknown), do: "launcher_unknown_failure"

  defp retryable?(source) when source in [:config_resolution, :state_file], do: false
  defp retryable?(_source), do: true

  defp duration_ms(started_at), do: System.monotonic_time(:millisecond) - started_at

  defp base_fields(%{} = entry_or_fields) do
    %{
      trace_id: field(entry_or_fields, :trace_id),
      run_id: field(entry_or_fields, :id) || field(entry_or_fields, :run_id),
      agent_id: field(entry_or_fields, :agent_id),
      workspace_id: field(entry_or_fields, :workspace_id),
      host: field(entry_or_fields, :host) || launcher_host(),
      port: field(entry_or_fields, :port),
      desired_state: field(entry_or_fields, :desired_state),
      actual_state: field(entry_or_fields, :actual_state) || field(entry_or_fields, :status),
      restart_count: field(entry_or_fields, :restart_count)
    }
    |> drop_nil_values()
  end

  defp base_fields(_), do: %{host: launcher_host()}

  defp field(map, key), do: Map.get(map, key) || Map.get(map, to_string(key))

  defp launcher_host, do: SymphonyElixir.Launcher.EngineInstance.host()

  defp table do
    case :ets.whereis(@table) do
      :undefined ->
        try do
          :ets.new(@table, [:named_table, :public, read_concurrency: true])
        rescue
          ArgumentError -> @table
        end

      _ ->
        @table
    end
  end

  defp normalize_event(event) when is_atom(event), do: Atom.to_string(event)
  defp normalize_event(event) when is_binary(event), do: event

  defp drop_nil_values(map), do: Map.reject(map, fn {_key, value} -> is_nil(value) end)

  defp encode_safe(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), encode_safe(value)} end)
  end

  defp encode_safe(values) when is_list(values), do: Enum.map(values, &encode_safe/1)
  defp encode_safe(value) when is_atom(value), do: Atom.to_string(value)
  defp encode_safe(value), do: value
end
