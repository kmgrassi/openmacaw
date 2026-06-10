defmodule SymphonyElixir.Orchestrator.DispatchPolicyReadinessTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Orchestrator.DispatchPolicy

  test "dispatch summary reports ready for routed active rows" do
    assert DispatchPolicy.dispatch_summary_for_row(%{
             "id" => "work-1",
             "title" => "Implement feature",
             "state" => "todo",
             "runner_kind" => "codex",
             "repository" => "parallel-agent-runtime"
           }) == %{
             "eligible" => true,
             "reason" => "ready",
             "blocked_by" => [],
             "runner_kind" => "codex",
             "repository" => "parallel-agent-runtime",
             "expected_pickup" => %{
               "status" => "planned",
               "message" => "not manager-runnable: state=todo, next_poll_at not set or not due",
               "eligible_at" => nil,
               "cadence_ms" => 60_000,
               "failed_gates" => ["manager_state", "next_poll_at"]
             }
           }
  end

  test "dispatch summary reports manager pickup only for due manager-runnable rows" do
    assert %{
             "eligible" => true,
             "reason" => "ready",
             "expected_pickup" => %{
               "status" => "eligible",
               "message" => "eligible at next manager tick (~60s)",
               "eligible_at" => "2026-01-01T12:00:00Z",
               "cadence_ms" => 60_000,
               "failed_gates" => []
             }
           } =
             DispatchPolicy.dispatch_summary_for_row(%{
               "id" => "work-1",
               "title" => "Implement feature",
               "state" => "running",
               "runner_kind" => "manager",
               "next_poll_at" => "2026-01-01T12:00:00Z"
             })
  end

  test "dispatch summary reports missing route when no runner hint resolves" do
    assert %{
             "eligible" => false,
             "reason" => "missing_route",
             "runner_kind" => nil,
             "expected_pickup" => %{
               "status" => "blocked",
               "message" => "blocked: no runner_kind resolved for dispatch",
               "eligible_at" => nil,
               "cadence_ms" => 60_000,
               "failed_gates" => ["runner_kind"]
             }
           } =
             DispatchPolicy.dispatch_summary_for_row(%{
               "id" => "work-1",
               "title" => "Implement feature",
               "state" => "todo"
             })
  end

  test "dispatch summary resolves runner kind from routing intent" do
    assert %{
             "eligible" => true,
             "reason" => "ready",
             "runner_kind" => "codex",
             "intent" => "implement"
           } =
             DispatchPolicy.dispatch_summary_for_row(%{
               "id" => "work-1",
               "title" => "Implement feature",
               "state" => "todo",
               "metadata" => %{"routing" => %{"intent" => "implement"}}
             })
  end

  test "dispatch summary resolves local coding intent to local model coding" do
    assert %{
             "eligible" => true,
             "runner_kind" => "local_model_coding",
             "intent" => "test"
           } =
             DispatchPolicy.dispatch_summary_for_row(%{
               "id" => "work-1",
               "title" => "Run focused tests",
               "state" => "todo",
               "metadata" => %{"routing" => %{"intent" => "test", "execution_location" => "local"}}
             })
  end

  test "dispatch summary reports draft or paused rows separately from route readiness" do
    assert %{
             "eligible" => false,
             "reason" => "draft_or_paused",
             "expected_pickup" => %{
               "status" => "blocked",
               "message" => "not manager-runnable: state=paused",
               "eligible_at" => nil,
               "cadence_ms" => 60_000,
               "failed_gates" => ["state"]
             }
           } =
             DispatchPolicy.dispatch_summary_for_row(%{
               "id" => "work-1",
               "title" => "Implement feature",
               "state" => "paused",
               "runner_kind" => "codex"
             })
  end

  test "dispatch summary reports invalid rows" do
    assert %{
             "eligible" => false,
             "reason" => "invalid_for_orchestrator",
             "expected_pickup" => %{
               "status" => "blocked",
               "message" => "not manager-runnable: invalid work item shape",
               "eligible_at" => nil,
               "cadence_ms" => 60_000,
               "failed_gates" => ["shape"]
             }
           } = DispatchPolicy.dispatch_summary_for_row(%{"id" => "work-1", "runner_kind" => "codex"})
  end

  test "dispatch summary includes pickup details for dependencies and future polls" do
    assert %{
             "expected_pickup" => %{
               "status" => "blocked",
               "message" => "blocked: depends_on dep-1 unresolved",
               "failed_gates" => ["dependencies"]
             }
           } =
             DispatchPolicy.dispatch_summary_for_row(%{
               "id" => "work-1",
               "title" => "Implement feature",
               "state" => "todo",
               "runner_kind" => "codex",
               "depends_on" => ["dep-1"]
             })

    assert %{
             "expected_pickup" => %{
               "status" => "waiting",
               "message" => "eligible after next_poll_at 2099-05-01T12:00:00Z",
               "eligible_at" => "2099-05-01T12:00:00Z",
               "failed_gates" => ["next_poll_at"]
             }
           } =
             DispatchPolicy.dispatch_summary_for_row(%{
               "id" => "work-1",
               "title" => "Implement feature",
               "state" => "todo",
               "runner_kind" => "codex",
               "next_poll_at" => "2099-05-01T12:00:00Z"
             })
  end
end
