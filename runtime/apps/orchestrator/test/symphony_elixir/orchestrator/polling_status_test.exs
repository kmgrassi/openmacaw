defmodule SymphonyElixir.Orchestrator.PollingStatusTest do
  use SymphonyElixir.TestSupport

  import SymphonyElixir.TestSupport.OrchestratorStatus

  test "orchestrator snapshot includes poll countdown and checking status" do
    pid = start_orchestrator!(__MODULE__, :PollingSnapshotOrchestrator)
    now_ms = System.monotonic_time(:millisecond)

    :sys.replace_state(pid, fn state ->
      %{
        state
        | poll_interval_ms: 30_000,
          tick_timer_ref: nil,
          tick_token: make_ref(),
          next_poll_due_at_ms: now_ms + 4_000,
          poll_check_in_progress: false
      }
    end)

    snapshot = GenServer.call(pid, :snapshot)

    assert %{polling: %{checking?: false, poll_interval_ms: 30_000, next_poll_in_ms: due_in_ms}} = snapshot
    assert is_integer(due_in_ms)
    assert due_in_ms >= 0
    assert due_in_ms <= 4_000

    :sys.replace_state(pid, fn state ->
      %{state | poll_check_in_progress: true, next_poll_due_at_ms: nil}
    end)

    snapshot = GenServer.call(pid, :snapshot)
    assert %{polling: %{checking?: true, next_poll_in_ms: nil}} = snapshot
  end

  test "orchestrator triggers an immediate poll cycle shortly after startup" do
    write_workflow_file!(Workflow.workflow_file_path(), tracker_api_token: nil, poll_interval_ms: 5_000)

    pid = start_orchestrator!(__MODULE__, :ImmediateStartupOrchestrator)

    assert %{polling: %{checking?: true}} =
             wait_for_snapshot(
               pid,
               fn
                 %{polling: %{checking?: true}} -> true
                 _ -> false
               end,
               500
             )

    assert %{polling: %{checking?: false, next_poll_in_ms: next_poll_in_ms, poll_interval_ms: 5_000}} =
             wait_for_snapshot(
               pid,
               fn
                 %{polling: %{checking?: false, next_poll_in_ms: due_in_ms}}
                 when is_integer(due_in_ms) and due_in_ms <= 5_000 ->
                   true

                 _ ->
                   false
               end,
               500
             )

    assert is_integer(next_poll_in_ms)
    assert next_poll_in_ms >= 0
  end

  test "orchestrator poll cycle resets next refresh countdown after a check" do
    write_workflow_file!(Workflow.workflow_file_path(), tracker_api_token: nil, poll_interval_ms: 50)

    pid = start_orchestrator!(__MODULE__, :PollCycleOrchestrator)

    :sys.replace_state(pid, fn state ->
      %{state | poll_interval_ms: 50, poll_check_in_progress: true, next_poll_due_at_ms: nil}
    end)

    send(pid, :run_poll_cycle)

    snapshot =
      wait_for_snapshot(pid, fn
        %{polling: %{checking?: false, poll_interval_ms: 50, next_poll_in_ms: next_poll_in_ms}}
        when is_integer(next_poll_in_ms) and next_poll_in_ms <= 50 ->
          true

        _ ->
          false
      end)

    assert %{polling: %{checking?: false, poll_interval_ms: 50, next_poll_in_ms: next_poll_in_ms}} = snapshot
    assert is_integer(next_poll_in_ms)
    assert next_poll_in_ms >= 0
    assert next_poll_in_ms <= 50
  end

  test "orchestrator restarts stalled workers with retry backoff" do
    write_workflow_file!(Workflow.workflow_file_path(), tracker_api_token: nil, codex_stall_timeout_ms: 1_000)

    issue_id = "issue-stall"
    pid = start_orchestrator!(__MODULE__, :StallOrchestrator)

    worker_pid =
      spawn(fn ->
        receive do
          :done -> :ok
        end
      end)

    stale_activity_at = DateTime.add(DateTime.utc_now(), -5, :second)

    issue = build_issue(issue_id, %{identifier: "MT-STALL"})

    attach_running_issue!(pid, issue, %{
      pid: worker_pid,
      ref: make_ref(),
      session_id: "thread-stall-turn-stall",
      last_codex_timestamp: stale_activity_at,
      last_codex_event: :notification,
      started_at: stale_activity_at
    })

    send(pid, :tick)
    Process.sleep(100)
    state = :sys.get_state(pid)

    refute Process.alive?(worker_pid)
    refute Map.has_key?(state.running, issue_id)

    assert %{attempt: 1, due_at_ms: due_at_ms, identifier: "MT-STALL", error: "stalled for " <> _} =
             state.retry_attempts[issue_id]

    assert is_integer(due_at_ms)
    remaining_ms = due_at_ms - System.monotonic_time(:millisecond)
    assert remaining_ms >= 9_500
    assert remaining_ms <= 10_500
  end
end
