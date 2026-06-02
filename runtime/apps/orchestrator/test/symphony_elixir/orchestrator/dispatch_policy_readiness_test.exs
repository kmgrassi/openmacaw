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
             "repository" => "parallel-agent-runtime"
           }
  end

  test "dispatch summary reports missing route when no runner hint resolves" do
    assert %{
             "eligible" => false,
             "reason" => "missing_route",
             "runner_kind" => nil
           } =
             DispatchPolicy.dispatch_summary_for_row(%{
               "id" => "work-1",
               "title" => "Implement feature",
               "state" => "todo"
             })
  end

  test "dispatch summary reports draft or paused rows separately from route readiness" do
    assert %{
             "eligible" => false,
             "reason" => "draft_or_paused"
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
             "reason" => "invalid_for_orchestrator"
           } = DispatchPolicy.dispatch_summary_for_row(%{"id" => "work-1", "runner_kind" => "codex"})
  end
end
