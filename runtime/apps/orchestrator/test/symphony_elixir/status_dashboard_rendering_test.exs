defmodule SymphonyElixir.StatusDashboardRenderingTest do
  use SymphonyElixir.TestSupport

  import SymphonyElixir.TestSupport.OrchestratorStatus

  test "status dashboard renders offline marker to terminal" do
    rendered =
      ExUnit.CaptureIO.capture_io(fn ->
        assert :ok = StatusDashboard.render_offline_status()
      end)

    assert rendered =~ "app_status=offline"
    refute rendered =~ "Timestamp:"
  end

  test "status dashboard renders linear project link in header" do
    rendered = StatusDashboard.format_snapshot_content_for_test({:ok, snapshot_data()}, 0.0)
    assert rendered =~ "https://linear.app/project/project/issues"
    refute rendered =~ "Dashboard:"
  end

  test "status dashboard renders dashboard url on its own line when server port is configured" do
    previous_port_override = Application.get_env(:symphony_elixir, :server_port_override)

    on_exit(fn ->
      if is_nil(previous_port_override) do
        Application.delete_env(:symphony_elixir, :server_port_override)
      else
        Application.put_env(:symphony_elixir, :server_port_override, previous_port_override)
      end
    end)

    Application.put_env(:symphony_elixir, :server_port_override, 4000)
    rendered = StatusDashboard.format_snapshot_content_for_test({:ok, snapshot_data()}, 0.0)

    assert rendered =~ "│ Project:"
    assert rendered =~ "https://linear.app/project/project/issues"
    assert rendered =~ "│ Dashboard:"
    assert rendered =~ "http://127.0.0.1:4000/"
  end

  test "status dashboard prefers the bound server port and normalizes wildcard hosts" do
    assert StatusDashboard.dashboard_url_for_test("0.0.0.0", 0, 43_123) == "http://127.0.0.1:43123/"
    assert StatusDashboard.dashboard_url_for_test("::1", 4000, nil) == "http://[::1]:4000/"
  end

  test "status dashboard renders next refresh countdown and checking marker" do
    waiting_snapshot =
      snapshot_data(%{polling: %{checking?: false, next_poll_in_ms: 2_000, poll_interval_ms: 30_000}})

    waiting_rendered = StatusDashboard.format_snapshot_content_for_test({:ok, waiting_snapshot}, 0.0)
    assert waiting_rendered =~ "Next refresh:"
    assert waiting_rendered =~ "2s"

    checking_snapshot =
      snapshot_data(%{polling: %{checking?: true, next_poll_in_ms: nil, poll_interval_ms: 30_000}})

    checking_rendered = StatusDashboard.format_snapshot_content_for_test({:ok, checking_snapshot}, 0.0)
    assert checking_rendered =~ "checking now…"
  end

  test "status dashboard adds a spacer line before backoff queue when no agents are active" do
    rendered = StatusDashboard.format_snapshot_content_for_test({:ok, snapshot_data()}, 0.0)
    plain = Regex.replace(~r/\e\[[0-9;]*m/, rendered, "")
    assert plain =~ ~r/No active agents\r?\n│\s*\r?\n├─ Backoff queue/
  end

  test "status dashboard adds a spacer line before backoff queue when agents are active" do
    snapshot =
      snapshot_data(%{
        running: [
          %{
            identifier: "MT-777",
            state: "running",
            session_id: "thread-1234567890",
            codex_app_server_pid: "4242",
            codex_total_tokens: 3_200,
            runtime_seconds: 75,
            turn_count: 7,
            last_codex_event: "turn_completed",
            last_codex_message: %{
              event: :notification,
              message: %{
                "method" => "turn/completed",
                "params" => %{"turn" => %{"status" => "completed"}}
              }
            }
          }
        ],
        codex_totals: %{input_tokens: 90, output_tokens: 12, total_tokens: 102, seconds_running: 75}
      })

    rendered = StatusDashboard.format_snapshot_content_for_test({:ok, snapshot}, 0.0)
    plain = Regex.replace(~r/\e\[[0-9;]*m/, rendered, "")
    assert plain =~ ~r/MT-777.*\r?\n│\s*\r?\n├─ Backoff queue/s
  end

  test "status dashboard renders an unstyled closing corner when the retry queue is empty" do
    rendered = StatusDashboard.format_snapshot_content_for_test({:ok, snapshot_data()}, 0.0)
    assert rendered |> String.split("\n") |> List.last() == "╰─"
  end

  test "status dashboard coalesces rapid updates to one render per interval" do
    dashboard_name = Module.concat(__MODULE__, :RenderDashboard)
    parent = self()
    orchestrator_pid = Process.whereis(SymphonyElixir.Orchestrator)

    on_exit(fn ->
      if is_nil(Process.whereis(SymphonyElixir.Orchestrator)) do
        case Supervisor.restart_child(SymphonyElixir.Supervisor, SymphonyElixir.Orchestrator) do
          {:ok, _pid} -> :ok
          {:error, {:already_started, _pid}} -> :ok
        end
      end
    end)

    if is_pid(orchestrator_pid) do
      assert :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, SymphonyElixir.Orchestrator)
    end

    {:ok, pid} =
      StatusDashboard.start_link(
        name: dashboard_name,
        enabled: true,
        refresh_ms: 60_000,
        render_interval_ms: 16,
        render_fun: fn content ->
          send(parent, {:render, System.monotonic_time(:millisecond), content})
        end
      )

    on_exit(fn ->
      if Process.alive?(pid) do
        Process.exit(pid, :normal)
      end
    end)

    StatusDashboard.notify_update(dashboard_name)
    assert_receive {:render, first_render_ms, _content}, 200

    :sys.replace_state(pid, fn state ->
      %{state | last_snapshot_fingerprint: :force_next_change, last_rendered_content: nil}
    end)

    StatusDashboard.notify_update(dashboard_name)
    StatusDashboard.notify_update(dashboard_name)

    assert_receive {:render, second_render_ms, _content}, 200
    assert second_render_ms > first_render_ms
    refute_receive {:render, _third_render_ms, _content}, 60
  end

  test "terminal dashboard output can be disabled for cloud log streams" do
    previous = System.get_env("SYMPHONY_TERMINAL_DASHBOARD")
    on_exit(fn -> restore_env("SYMPHONY_TERMINAL_DASHBOARD", previous) end)

    System.put_env("SYMPHONY_TERMINAL_DASHBOARD", "false")
    refute StatusDashboard.terminal_dashboard_output_enabled_for_test()

    System.put_env("SYMPHONY_TERMINAL_DASHBOARD", "true")
    assert StatusDashboard.terminal_dashboard_output_enabled_for_test()
  end

  test "status dashboard computes rolling 5-second token throughput" do
    assert StatusDashboard.rolling_tps([], 10_000, 0) == 0.0
    assert StatusDashboard.rolling_tps([{9_000, 20}], 10_000, 40) == 20.0
    assert StatusDashboard.rolling_tps([{4_900, 10}], 10_000, 90) == 0.0

    tps =
      StatusDashboard.rolling_tps(
        [{9_500, 10}, {9_000, 40}, {8_000, 80}],
        10_000,
        95
      )

    assert tps == 7.5
  end

  test "status dashboard throttles tps updates to once per second" do
    {first_second, first_tps} = StatusDashboard.throttled_tps(nil, nil, 10_000, [{9_000, 20}], 40)
    {same_second, same_tps} = StatusDashboard.throttled_tps(first_second, first_tps, 10_500, [{9_000, 20}], 200)

    assert same_second == first_second
    assert same_tps == first_tps

    {next_second, next_tps} = StatusDashboard.throttled_tps(same_second, same_tps, 11_000, [{10_500, 200}], 260)

    assert next_second == 11
    refute next_tps == same_tps
  end

  test "status dashboard formats timestamps at second precision" do
    dt = ~U[2026-02-15 21:36:38.987654Z]
    assert StatusDashboard.format_timestamp_for_test(dt) == "2026-02-15 21:36:38Z"
  end

  test "status dashboard renders 10-minute TPS graph snapshot for steady throughput" do
    now_ms = 600_000
    current_tokens = 6_000

    samples =
      for timestamp <- 575_000..0//-25_000 do
        {timestamp, div(timestamp, 100)}
      end

    assert StatusDashboard.tps_graph_for_test(samples, now_ms, current_tokens) == "████████████████████████"
  end

  test "status dashboard renders 10-minute TPS graph snapshot for ramping throughput" do
    now_ms = 600_000
    rates_per_bucket = Enum.map(1..24, &(&1 * 2))
    {current_tokens, samples} = graph_samples_from_rates(rates_per_bucket)

    assert StatusDashboard.tps_graph_for_test(samples, now_ms, current_tokens) ==
             "▁▂▂▂▃▃▃▃▄▄▄▅▅▅▆▆▆▆▇▇▇██▅"
  end

  test "status dashboard keeps historical TPS bars stable within the active bucket" do
    now_ms = 600_000
    current_tokens = 74_400
    next_current_tokens = current_tokens + 120
    samples = graph_samples_for_stability_test(now_ms)

    graph_at_now = StatusDashboard.tps_graph_for_test(samples, now_ms, current_tokens)
    graph_next_second = StatusDashboard.tps_graph_for_test(samples, now_ms + 1_000, next_current_tokens)

    historical_changes =
      graph_at_now
      |> String.graphemes()
      |> Enum.zip(String.graphemes(graph_next_second))
      |> Enum.take(23)
      |> Enum.count(fn {left, right} -> left != right end)

    assert historical_changes == 0
  end

  test "application configures a rotating file logger handler" do
    assert {:ok, handler_config} = :logger.get_handler_config(:symphony_disk_log)
    assert handler_config.module == :logger_disk_log_h

    disk_config = handler_config.config
    assert disk_config.type == :wrap
    assert is_list(disk_config.file)
    assert disk_config.max_no_bytes > 0
    assert disk_config.max_no_files > 0
  end

  test "application stop renders offline status" do
    on_exit(fn ->
      {:ok, _started} = Application.ensure_all_started(:symphony_elixir)
    end)

    rendered =
      ExUnit.CaptureIO.capture_io(fn ->
        assert :ok = SymphonyElixir.Application.stop(:normal)
      end)

    assert {:ok, _started} = Application.ensure_all_started(:symphony_elixir)
    assert rendered =~ "app_status=offline"
    refute rendered =~ "Timestamp:"
  end
end
