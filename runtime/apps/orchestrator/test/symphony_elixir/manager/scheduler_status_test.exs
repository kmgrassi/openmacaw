defmodule SymphonyElixir.Manager.SchedulerStatusTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Manager.SchedulerStatus

  test "computes a running status payload from scheduler state" do
    status =
      SchedulerStatus.compute(%{
        workspace_id: "workspace-1",
        agent_id: "manager-agent-1",
        session: %{
          runner: SymphonyElixir.Runner.Manager,
          provider: "openai",
          model: "gpt-test"
        },
        session_details: %{credential_id: "credential-1"},
        idle_reason: nil,
        session_error: nil,
        min_cadence_ms: 60_000,
        last_tick_at: ~U[2026-05-14 12:00:00Z],
        last_decision_count: 2,
        last_error: nil,
        consecutive_error_count: 0,
        trace_id: "trace-1"
      })

    assert %SchedulerStatus{
             status: :running,
             missing: [],
             provider: "openai",
             model: "gpt-test"
           } = status

    assert %{
             status: :running,
             agent_id: "manager-agent-1",
             credential_id: "credential-1",
             provider: "openai",
             model: "gpt-test",
             runner: "SymphonyElixir.Runner.Manager"
           } = SchedulerStatus.to_payload(status)
  end

  test "computes idle credential status and log fields" do
    status =
      SchedulerStatus.compute(%{
        workspace_id: "workspace-1",
        agent_id: "manager-agent-1",
        session: %{workspace_id: "workspace-1"},
        session_details: %{provider: "openai", model: "gpt-test"},
        idle_reason: :credential_missing,
        session_error: nil,
        min_cadence_ms: 60_000,
        last_tick_at: nil,
        last_decision_count: 0,
        last_error: nil,
        consecutive_error_count: 0,
        trace_id: "trace-1"
      })

    assert status.status == :idle_awaiting_credential
    assert status.missing == ["credential"]
    assert SchedulerStatus.skip_reason(status) == :missing_session
    assert SchedulerStatus.log_level(status) == :info

    assert %{
             scheduler_health: :idle_awaiting_credential,
             idle_reason: :credential_missing,
             trace_id: "trace-log"
           } = SchedulerStatus.log_fields(status, "trace-log")
  end

  test "formats exception diagnostic fields and truncates oversize messages" do
    long_message = String.duplicate("x", 1_100)

    assert %{
             error_class: "RuntimeError",
             error_message: truncated_message,
             tick_phase: :due_query
           } =
             SchedulerStatus.exception_log_fields(
               {:exception, RuntimeError, long_message},
               tick_phase: :due_query
             )

    assert String.length(truncated_message) == 1_024

    assert %{
             error_class: "ArgumentError",
             error_message: "bad argument"
           } = SchedulerStatus.exception_log_fields(ArgumentError.exception("bad argument"))
  end

  test "ignores non-exception structs when building exception log fields" do
    assert SchedulerStatus.exception_log_fields(%URI{path: "/health"}) == %{}
  end
end
