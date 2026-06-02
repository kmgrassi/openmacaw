defmodule SymphonyElixir.Tracker.APITest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Tracker.API, as: TrackerAPI
  alias SymphonyElixir.WorkItem

  @moduletag :tracker_api

  setup do
    # Start the API tracker GenServer for each test
    case GenServer.whereis(TrackerAPI) do
      nil -> start_supervised!(TrackerAPI)
      pid -> GenServer.stop(pid); start_supervised!(TrackerAPI)
    end

    write_workflow_file!(
      Application.get_env(:symphony_elixir, :workflow_file_path),
      tracker_kind: "api",
      tracker_api_token: nil,
      tracker_project_slug: nil
    )

    :ok
  end

  describe "accept_item/1" do
    test "accepts a valid work item" do
      payload = %{
        "title" => "Deploy to staging",
        "description" => "Run the staging deploy pipeline"
      }

      assert {:ok, %WorkItem{} = item} = TrackerAPI.accept_item(payload)
      assert item.title == "Deploy to staging"
      assert item.source == "api"
      assert item.state == "Todo"
      assert is_binary(item.id)
    end

    test "rejects payload missing required fields" do
      assert {:error, {:missing_fields, ["title"]}} = TrackerAPI.accept_item(%{})
    end

    test "rejects non-map payload" do
      assert {:error, :invalid_payload} = TrackerAPI.accept_item("not a map")
    end

    test "uses provided id and identifier" do
      payload = %{
        "id" => "custom-id",
        "identifier" => "TASK-42",
        "title" => "Custom task"
      }

      assert {:ok, %WorkItem{id: "custom-id", identifier: "TASK-42"}} =
               TrackerAPI.accept_item(payload)
    end
  end

  describe "fetch_candidate_issues/0" do
    test "returns accepted items in active states" do
      TrackerAPI.accept_item(%{"title" => "Task 1", "state" => "Todo"})
      TrackerAPI.accept_item(%{"title" => "Task 2", "state" => "Done"})

      assert {:ok, items} = TrackerAPI.fetch_candidate_issues()
      assert length(items) == 1
      assert hd(items).title == "Task 1"
    end
  end

  describe "fetch_issues_by_states/1" do
    test "filters items by state" do
      TrackerAPI.accept_item(%{"title" => "Task A", "state" => "Todo"})
      TrackerAPI.accept_item(%{"title" => "Task B", "state" => "In Progress"})
      TrackerAPI.accept_item(%{"title" => "Task C", "state" => "Done"})

      assert {:ok, items} = TrackerAPI.fetch_issues_by_states(["In Progress"])
      assert length(items) == 1
      assert hd(items).title == "Task B"
    end
  end

  describe "fetch_issue_states_by_ids/1" do
    test "filters items by id" do
      {:ok, item} = TrackerAPI.accept_item(%{"id" => "id-1", "title" => "Task 1"})
      TrackerAPI.accept_item(%{"id" => "id-2", "title" => "Task 2"})

      assert {:ok, [found]} = TrackerAPI.fetch_issue_states_by_ids(["id-1"])
      assert found.id == item.id
    end
  end

  describe "update_issue_state/2" do
    test "updates an existing item's state" do
      {:ok, item} = TrackerAPI.accept_item(%{"title" => "Task", "state" => "Todo"})

      assert :ok = TrackerAPI.update_issue_state(item.id, "Done")

      assert {:ok, [updated]} = TrackerAPI.fetch_issues_by_states(["Done"])
      assert updated.state == "Done"
    end

    test "returns error for unknown id" do
      assert {:error, :not_found} = TrackerAPI.update_issue_state("unknown", "Done")
    end
  end

  describe "create_comment/2" do
    test "always succeeds (no-op)" do
      assert :ok = TrackerAPI.create_comment("any-id", "any body")
    end
  end
end
