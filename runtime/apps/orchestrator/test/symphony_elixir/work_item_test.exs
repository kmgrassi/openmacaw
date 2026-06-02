defmodule SymphonyElixir.WorkItemTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.WorkItem

  describe "struct creation" do
    test "creates with defaults" do
      item = %WorkItem{}
      assert item.labels == []
      assert item.metadata == %{}
      assert item.assigned_to_worker == true
      assert item.created_at == nil
      assert item.updated_at == nil
      assert item.source == nil
      assert item.runner_type == nil
      assert item.repository_id == nil
      assert item.repository == nil
    end

    test "creates with all fields" do
      now = DateTime.utc_now()

      item = %WorkItem{
        id: "item-1",
        identifier: "PROJ-1",
        title: "Fix bug",
        description: "Something is broken",
        priority: 1,
        state: "Todo",
        url: "https://example.com/item-1",
        source: "linear",
        runner_type: "codex",
        repository_id: "repo-1",
        repository: "parallel-agent-runtime",
        labels: ["bug", "urgent"],
        metadata: %{branch_name: "fix-bug", assignee_id: "user-1", blocked_by: []},
        assigned_to_worker: true,
        created_at: now,
        updated_at: now
      }

      assert item.id == "item-1"
      assert item.identifier == "PROJ-1"
      assert item.title == "Fix bug"
      assert item.description == "Something is broken"
      assert item.priority == 1
      assert item.state == "Todo"
      assert item.url == "https://example.com/item-1"
      assert item.source == "linear"
      assert item.runner_type == "codex"
      assert item.repository_id == "repo-1"
      assert item.repository == "parallel-agent-runtime"
      assert item.labels == ["bug", "urgent"]
      assert item.metadata.branch_name == "fix-bug"
      assert item.metadata.assignee_id == "user-1"
      assert item.metadata.blocked_by == []
      assert item.assigned_to_worker == true
      assert item.created_at == now
      assert item.updated_at == now
    end
  end

  describe "label_names/1" do
    test "returns the labels list" do
      item = %WorkItem{labels: ["bug", "feature"]}
      assert WorkItem.label_names(item) == ["bug", "feature"]
    end

    test "returns empty list when no labels" do
      item = %WorkItem{}
      assert WorkItem.label_names(item) == []
    end
  end

  describe "first-class task_id / plan_id" do
    test "struct exposes task_id and plan_id fields (nil by default)" do
      item = %WorkItem{}
      assert item.task_id == nil
      assert item.plan_id == nil
    end

    test "struct accepts task_id and plan_id values" do
      item = %WorkItem{
        task_id: "00000000-0000-0000-0000-000000000aaa",
        plan_id: "00000000-0000-0000-0000-000000000bbb"
      }

      assert item.task_id == "00000000-0000-0000-0000-000000000aaa"
      assert item.plan_id == "00000000-0000-0000-0000-000000000bbb"
    end
  end
end
