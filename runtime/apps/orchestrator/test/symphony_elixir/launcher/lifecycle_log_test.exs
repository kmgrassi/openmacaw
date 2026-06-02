defmodule SymphonyElixir.Launcher.LifecycleLogTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Launcher.LifecycleLog

  setup do
    LifecycleLog.reset()
    :ok
  end

  test "classifies launcher startup failures" do
    assert LifecycleLog.classify_failure(:eaddrinuse, :start) == :port_allocation
    assert LifecycleLog.classify_failure({:health_check_failed, 503}, :start) == :health_check
    assert LifecycleLog.classify_failure({:invalid_agent_config, "bad", %{}}, :start) == :config_resolution
    assert LifecycleLog.classify_failure({:shutdown, :boom}, :start) == :process_spawn
  end

  test "records sanitized latest failure summary" do
    log =
      capture_log(fn ->
        LifecycleLog.log_failure(
          :warning,
          :engine_instance_heartbeat_failed,
          %{id: "orch_1", agent_id: "agent-1", workspace_id: "workspace-1", port: 4000},
          nil,
          {:error, :timeout},
          operation: :engine_instance,
          desired_state: :running
        )
      end)

    payload = decode_logged_json!(log)
    assert payload["event"] == "engine_instance_heartbeat_failed"
    assert payload["error_code"] == "launcher_database_heartbeat_failed"
    assert payload["failure_source"] == "database_heartbeat"
    assert payload["retryable"] == true

    assert %{
             "event" => "engine_instance_heartbeat_failed",
             "run_id" => "orch_1",
             "error_code" => "launcher_database_heartbeat_failed",
             "failure_source" => "database_heartbeat"
           } = LifecycleLog.latest_failure()
  end

  defp decode_logged_json!(log) do
    log
    |> String.split("\n", trim: true)
    |> Enum.find_value(fn line ->
      case Regex.run(~r/(\{.*\})/, line) do
        [_, json] -> Jason.decode!(json)
        _ -> nil
      end
    end)
  end
end
