defmodule SymphonyElixir.Orchestrator.ExecutionSlotTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Orchestrator.ExecutionSlot

  describe "eligibility/2" do
    test "marks a slot with matching repo id and capacity eligible" do
      slot = slot()

      assert ExecutionSlot.eligibility(slot, request()) == {:eligible, slot}
      assert ExecutionSlot.eligible?(slot, request())
    end

    test "rejects slots from the wrong workspace" do
      slot = slot(workspace_id: "workspace-2")

      assert ExecutionSlot.eligibility(slot, request()) ==
               {:ineligible, :workspace_mismatch, slot}
    end

    test "rejects slots without the requested runner kind" do
      slot = slot(runner_kinds: ["planner"])

      assert ExecutionSlot.eligibility(slot, request()) ==
               {:ineligible, :runner_kind_mismatch, slot}
    end

    test "rejects slots without capacity" do
      slot = slot(available_slots: 0)

      assert ExecutionSlot.eligibility(slot, request()) ==
               {:ineligible, :no_capacity, slot}
    end

    test "rejects slots without the requested repository cache" do
      slot = slot(cached_repo_ids: ["repo-2"])

      assert ExecutionSlot.eligibility(slot, request()) ==
               {:ineligible, :repo_cache_miss, slot}
    end

    test "filters eligible slots" do
      eligible = slot(id: "slot-eligible")
      wrong_repo = slot(id: "slot-wrong-repo", cached_repo_ids: ["repo-2"])
      full = slot(id: "slot-full", available_slots: 0)

      assert ExecutionSlot.eligible_slots([wrong_repo, eligible, full], request()) == [eligible]
    end

    test "accepts string-keyed capability snapshots and requests" do
      slot =
        ExecutionSlot.new(%{
          "id" => "slot-json",
          "workspace_id" => "workspace-1",
          "runner_kinds" => ["codex"],
          "execution_target" => "worker_host",
          "available_slots" => 1,
          "cached_repo_ids" => ["repo-1"],
          "cache_state" => %{"repo-1" => "ready"}
        })

      assert ExecutionSlot.eligibility(slot, %{
               "workspace_id" => "workspace-1",
               "runner_kind" => "codex",
               "execution_target" => "worker_host",
               "repo_id" => "repo-1"
             }) == {:eligible, slot}
    end
  end

  defp request do
    %{
      workspace_id: "workspace-1",
      runner_kind: "codex",
      execution_target: "worker_host",
      repo_id: "repo-1"
    }
  end

  defp slot(overrides \\ []) do
    ExecutionSlot.new(
      Keyword.merge(
        [
          id: "slot-1",
          workspace_id: "workspace-1",
          runner_kinds: ["codex", "planner"],
          execution_target: "worker_host",
          available_slots: 1,
          cached_repo_ids: ["repo-1"],
          cache_state: %{repo_id: "repo-1", state: "ready"}
        ],
        overrides
      )
    )
  end
end
