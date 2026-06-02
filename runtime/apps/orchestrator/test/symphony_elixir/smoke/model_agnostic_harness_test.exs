defmodule SymphonyElixir.Smoke.ModelAgnosticHarnessTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Smoke.ModelAgnosticHarness

  @fixture Path.expand(
             "../../../priv/fixtures/model_agnostic_smoke/planning_to_coding_handoff.json",
             __DIR__
           )

  test "replays the planning to coding handoff fixture without provider calls" do
    assert {:ok, summary} = ModelAgnosticHarness.run_fixture(@fixture)

    assert summary.scenario == "planning-anthropic-to-coding-codex"
    assert summary.planning.provider == "anthropic"
    assert summary.planning.task_count == 2
    assert summary.approval.approved_task_ids == ["task-1"]
    assert summary.coding.provider == "openai_codex"
    assert summary.coding.runner_kind == "codex"
    assert summary.coding.handoff_count == 1
    assert summary.coding.approved_plan_id == "plan-1"
    assert summary.coding.selected_task_ids == ["task-1"]
    assert summary.coding.work_item_identifiers == ["PLAN-1"]
  end

  test "rejects fixture envelopes that contain secret-bearing fields" do
    fixture = %{
      "planning_start" => %{
        "execution_profile" => valid_profile("planning")
      },
      "planning_events" => [],
      "approval" => %{"approved_task_ids" => []},
      "coding_dispatch" => %{
        "execution_profile" => valid_profile("coding"),
        "work_items" => [],
        "api_key" => "should-not-be-here"
      }
    }

    assert {:error, {:secret_field_present, "coding_dispatch.api_key"}} =
             ModelAgnosticHarness.run(fixture)
  end

  test "rejects coding handoffs that include unapproved tasks" do
    fixture =
      @fixture
      |> File.read!()
      |> Jason.decode!()
      |> put_in(["coding_dispatch", "work_items", Access.at(0), "task_id"], "task-2")

    assert {:error, {:coding_handoff_does_not_match_approval, ["task-2"], ["task-1"]}} =
             ModelAgnosticHarness.run(fixture)
  end

  test "rejects coding dispatches missing the explicit planner launch envelope" do
    fixture =
      @fixture
      |> File.read!()
      |> Jason.decode!()
      |> update_in(["coding_dispatch"], &Map.delete(&1, "launch_params"))

    assert {:error, :coding_dispatch_requires_launch_params} = ModelAgnosticHarness.run(fixture)
  end

  test "rejects coding launch envelopes that do not match approval" do
    fixture =
      @fixture
      |> File.read!()
      |> Jason.decode!()
      |> put_in(["coding_dispatch", "launch_params", "selected_task_ids"], ["task-2"])

    assert {:error, {:coding_launch_task_mismatch, ["task-2"], ["task-1"]}} =
             ModelAgnosticHarness.run(fixture)
  end

  defp valid_profile(role) do
    %{
      "agent_id" => "agent-#{role}",
      "workspace_id" => "workspace-1",
      "role" => role,
      "runner_kind" => "fixture",
      "provider" => "fixture_provider",
      "model" => "fixture-model",
      "credential_ref" => "alias:fixture",
      "tool_profile" => "fixture_tools"
    }
  end
end
