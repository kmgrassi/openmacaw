defmodule SymphonyElixir.Tracker.DatabaseTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Tracker.Database
  alias SymphonyElixir.WorkItem

  @moduletag :tracker_database

  @fixture_dir Path.expand("../../fixtures/supabase", __DIR__)

  setup do
    Application.put_env(:symphony_elixir, :database_tracker_req_options, plug: {Req.Test, Database})

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :database_tracker_req_options)
    end)

    :ok
  end

  defp write_workflow(extra \\ []) do
    base = [
      tracker_kind: "database",
      tracker_endpoint: "https://test.supabase.co/rest/v1",
      tracker_api_token: "test-api-key",
      tracker_project_slug: nil,
      tracker_table: "work_items"
    ]

    write_workflow_file!(Application.get_env(:symphony_elixir, :workflow_file_path), Keyword.merge(base, extra))
  end

  defp fixture!(name) do
    @fixture_dir
    |> Path.join(name)
    |> File.read!()
    |> Jason.decode!()
  end

  describe "fetch_candidate_issues/0" do
    test "maps live work_items schema rows to WorkItem structs" do
      write_workflow()

      rows = fixture!("work_items_fetch_candidates.json")

      Req.Test.stub(Database, fn conn ->
        assert conn.method == "GET"
        assert conn.request_path == "/rest/v1/work_items"

        query = URI.decode_query(conn.query_string)
        assert query["state"] == "in.(Todo,In Progress)"
        assert String.starts_with?(query["order"], "priority")

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!(rows))
      end)

      assert {:ok, [first, second]} = Database.fetch_candidate_issues()

      assert %WorkItem{
               id: "00000000-0000-0000-0000-000000000001",
               identifier: "WI-1",
               title: "Migrate adapter",
               state: "Todo",
               priority: "2",
               source: "database",
               runner_type: "codex",
               repository: "parallel-agent-runtime",
               task_id: "00000000-0000-0000-0000-000000000aaa",
               plan_id: "00000000-0000-0000-0000-000000000bbb",
               labels: ["backend"],
               url: "https://example.test/work-items/WI-1"
             } = first

      assert first.metadata["branch_name"] == "feat/migrate-adapter"
      # url column does not exist on work_items; should be surfaced from metadata.url
      refute Map.has_key?(
               fixture!("work_items_fetch_candidates.json") |> List.first(),
               "url"
             )

      assert second.task_id == nil
      assert second.priority == nil
    end

    test "scopes candidate polling to plan and runner_type when configured" do
      write_workflow(
        tracker_workspace_id: "00000000-0000-0000-0000-000000000111",
        tracker_plan_id: "00000000-0000-0000-0000-000000000222",
        tracker_runner_type: "codex"
      )

      Req.Test.stub(Database, fn conn ->
        assert conn.method == "GET"
        assert conn.request_path == "/rest/v1/work_items"

        query = URI.decode_query(conn.query_string)
        assert query["workspace_id"] == "eq.00000000-0000-0000-0000-000000000111"
        assert query["plan_id"] == "eq.00000000-0000-0000-0000-000000000222"
        assert query["runner_kind"] == "eq.codex"
        assert query["state"] == "in.(Todo,In Progress)"

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!([]))
      end)

      log =
        capture_log([level: :debug], fn ->
          assert {:ok, []} = Database.fetch_candidate_issues()
        end)

      assert log =~ ~s("caller":"tracker.database.fetch_candidate_issues")
      assert log =~ ~s("workspace_id":"00000000-0000-0000-0000-000000000111")
      assert log =~ ~s("plan_id":"00000000-0000-0000-0000-000000000222")
    end

    test "workspace argument overrides configured workspace scope" do
      write_workflow(
        tracker_workspace_id: "00000000-0000-0000-0000-000000000111",
        tracker_plan_id: "00000000-0000-0000-0000-000000000222"
      )

      Req.Test.stub(Database, fn conn ->
        query = URI.decode_query(conn.query_string)
        assert query["workspace_id"] == "eq.00000000-0000-0000-0000-000000000333"
        assert query["plan_id"] == "eq.00000000-0000-0000-0000-000000000222"

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!([]))
      end)

      assert {:ok, []} = Database.fetch_candidate_issues("00000000-0000-0000-0000-000000000333")
    end

    test "scopes state refresh reads to configured plan" do
      write_workflow(
        tracker_workspace_id: "00000000-0000-0000-0000-000000000111",
        tracker_plan_id: "00000000-0000-0000-0000-000000000222",
        tracker_runner_type: "codex"
      )

      Req.Test.stub(Database, fn conn ->
        query = URI.decode_query(conn.query_string)
        assert query["workspace_id"] == "eq.00000000-0000-0000-0000-000000000111"
        assert query["plan_id"] == "eq.00000000-0000-0000-0000-000000000222"
        assert query["id"] == "in.(00000000-0000-0000-0000-000000000001)"
        refute Map.has_key?(query, "metadata->>runner_type")

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!([]))
      end)

      assert {:ok, []} = Database.fetch_issue_states_by_ids(["00000000-0000-0000-0000-000000000001"])
    end
  end

  describe "update_issue_state/2 with writeback" do
    test "writes state to the task table using WorkItem.task_id" do
      write_workflow(
        tracker_writeback_table: "task",
        tracker_writeback_id_field: "task_id",
        tracker_workspace_id: "00000000-0000-0000-0000-000000000111"
      )

      item = %WorkItem{
        id: "00000000-0000-0000-0000-000000000001",
        identifier: "WI-1",
        task_id: "00000000-0000-0000-0000-000000000aaa"
      }

      parent = self()

      Req.Test.stub(Database, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(parent, {:patch, conn.method, conn.request_path, conn.query_string, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(204, "")
      end)

      assert :ok = Database.update_issue_state(item, "done")

      assert_received {:patch, "PATCH", path, query, payload}
      assert path == "/rest/v1/task"

      assert URI.decode_query(query) == %{"id" => "eq.00000000-0000-0000-0000-000000000aaa"}

      # task uses `status`, not `state`
      assert payload == %{"status" => "done"}
    end

    test "errors loudly when task_id is nil but writeback.id_field requires it" do
      write_workflow(tracker_writeback_table: "task", tracker_writeback_id_field: "task_id")

      Req.Test.stub(Database, fn _conn ->
        raise "HTTP should not be called when task_id is missing"
      end)

      item = %WorkItem{id: "00000000-0000-0000-0000-000000000001", identifier: "WI-1", task_id: nil}

      assert_raise ArgumentError, ~r/task_id/, fn ->
        Database.update_issue_state(item, "done")
      end
    end

    test "rejects bare-id callers when writeback.id_field is configured" do
      write_workflow(tracker_writeback_table: "task", tracker_writeback_id_field: "task_id")

      assert {:error, {:missing_writeback_id, msg}} =
               Database.update_issue_state("00000000-0000-0000-0000-000000000001", "done")

      assert msg =~ "WorkItem"
    end
  end

  describe "update_issue_state/2 without writeback" do
    test "falls back to patching the read table on the WorkItem id" do
      write_workflow()

      parent = self()

      Req.Test.stub(Database, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(parent, {:patch, conn.request_path, conn.query_string, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(204, "")
      end)

      assert :ok = Database.update_issue_state("uuid-1", "Done")
      assert_received {:patch, "/rest/v1/work_items", query, payload}
      assert URI.decode_query(query) == %{"id" => "eq.uuid-1"}
      assert payload == %{"state" => "Done"}
    end

    test "honors writeback.table for bare-id callers when id_field is unset" do
      # Regression: previously the bare-id clause always patched config.table,
      # even when writeback.table was configured — letting %WorkItem{} callers
      # and bare-id callers write to different tables in the same deployment.
      write_workflow(tracker_writeback_table: "task", tracker_writeback_id_field: nil)

      parent = self()

      Req.Test.stub(Database, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(parent, {:patch, conn.request_path, conn.query_string, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(204, "")
      end)

      assert :ok = Database.update_issue_state("uuid-1", "done")

      assert_received {:patch, "/rest/v1/task", query, payload}
      assert URI.decode_query(query) == %{"id" => "eq.uuid-1"}
      # writeback.table == "task" uses `status`, not `state`
      assert payload == %{"status" => "done"}
    end
  end

  describe "create_comment/2" do
    test "POSTs to work_item_comments with author + source" do
      write_workflow()

      parent = self()

      Req.Test.stub(Database, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(parent, {:post, conn.request_path, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(201, "")
      end)

      assert :ok = Database.create_comment("00000000-0000-0000-0000-000000000001", "hello world")

      assert_received {:post, "/rest/v1/work_item_comments", payload}

      assert payload == %{
               "work_item_id" => "00000000-0000-0000-0000-000000000001",
               "body" => "hello world",
               "author" => "orchestrator",
               "source" => "orchestrator"
             }
    end

    test "respects configured comment_author override" do
      write_workflow(tracker_comment_author: "symphony-bot")

      parent = self()

      Req.Test.stub(Database, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(parent, {:post, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(201, "")
      end)

      assert :ok = Database.create_comment("uuid-1", "note")
      assert_received {:post, %{"author" => "symphony-bot", "source" => "orchestrator"}}
    end
  end
end
