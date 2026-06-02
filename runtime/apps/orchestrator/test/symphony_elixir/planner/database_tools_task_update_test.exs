defmodule SymphonyElixir.Planner.DatabaseToolsTaskUpdateTest do
  use SymphonyElixir.Planner.DatabaseToolsCase

  test "task.update patches only allowed fields with id and workspace predicates" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.work-item-1",
                   "workspace_id" => "eq.workspace-1",
                   "order" => "id.asc",
                   "limit" => "1"
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "workspace_id" => "workspace-1",
                "title" => "Old",
                "description" => "D",
                "state" => "todo",
                "metadata" => %{"existing" => true}
              }
            ])
          )

        {"PATCH", "/rest/v1/work_items"} ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.work-item-1",
                   "workspace_id" => "eq.workspace-1",
                   "order" => "id.asc",
                   "limit" => "1"
                 }

          assert {"prefer", "return=representation"} in conn.req_headers

          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert Jason.decode!(body) == %{
                   "state" => "done",
                   "metadata" => %{"existing" => true, "checked" => true}
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "state" => "done",
                "metadata" => %{"existing" => true, "checked" => true}
              }
            ])
          )
      end
    end)

    assert {:ok,
            %{
              "id" => "work-item-1",
              "state" => "done",
              "metadata" => %{"existing" => true, "checked" => true},
              "changed_fields" => ["metadata", "state"]
            }} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "status" => "done",
               "metadata" => %{"checked" => true},
               "ignored" => "not patched"
             })
  end

  test "task.update can change only state without re-passing unchanged fields" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "workspace_id" => "workspace-1",
                "title" => "Old",
                "description" => "D",
                "state" => "todo"
              }
            ])
          )

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert Jason.decode!(body) == %{"state" => "running"}

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "workspace_id" => "workspace-1",
                "title" => "Old",
                "description" => "D",
                "state" => "running"
              }
            ])
          )
      end
    end)

    assert {:ok,
            %{
              "title" => "Old",
              "description" => "D",
              "state" => "running",
              "changed_fields" => ["state"]
            }} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "state" => "running"
             })
  end

  test "task.update clears nullable fields and rejects null for non-nullable fields" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([%{"id" => "work-item-1", "workspace_id" => "workspace-1", "description" => "D"}])
          )

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert Jason.decode!(body) == %{"description" => nil}

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([%{"id" => "work-item-1", "workspace_id" => "workspace-1", "description" => nil}])
          )
      end
    end)

    assert {:ok, %{"description" => nil, "changed_fields" => ["description"]}} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "description" => nil
             })

    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when task.update null is invalid")
    end)

    assert {:error, {:invalid_null, "name is non-nullable"}} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "name" => nil
             })
  end

  test "task.update returns no changed fields and skips patch when update is a no-op" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!([%{"id" => "work-item-1", "workspace_id" => "workspace-1", "title" => "T1"}])
      )
    end)

    assert {:ok, %{"id" => "work-item-1", "title" => "T1", "changed_fields" => []}} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "name" => "T1"
             })
  end

  test "task.update returns not found when scoped patch affects zero rows after read" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([%{"id" => "work-item-1", "workspace_id" => "workspace-1", "state" => "todo"}])
          )

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert Jason.decode!(body) == %{"state" => "running"}

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([]))
      end
    end)

    assert {:error, {:task_not_found, "work-item-1", "workspace-1"}} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "state" => "running"
             })
  end

  test "task.update accepts if_updated_at as an optimistic concurrency guard" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "workspace_id" => "workspace-1",
                "state" => "todo",
                "updated_at" => "2026-05-19T12:00:00Z"
              }
            ])
          )

        {"PATCH", "/rest/v1/work_items"} ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.work-item-1",
                   "workspace_id" => "eq.workspace-1",
                   "updated_at" => "eq.2026-05-19T12:00:00Z",
                   "order" => "id.asc",
                   "limit" => "1"
                 }

          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert Jason.decode!(body) == %{"state" => "done"}

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "state" => "done",
                "updated_at" => "2026-05-19T12:00:01Z"
              }
            ])
          )
      end
    end)

    assert {:ok,
            %{
              "id" => "work-item-1",
              "state" => "done",
              "updated_at" => "2026-05-19T12:00:01Z",
              "changed_fields" => ["state"]
            }} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "state" => "done",
               "if_updated_at" => "2026-05-19T12:00:00Z"
             })
  end

  test "task.update rejects stale if_updated_at values" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "workspace_id" => "workspace-1",
                "state" => "todo",
                "updated_at" => "2026-05-19T12:05:00Z"
              }
            ])
          )

        {"PATCH", "/rest/v1/work_items"} ->
          assert URI.decode_query(conn.query_string)["updated_at"] == "eq.2026-05-19T12:00:00Z"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([]))
      end
    end)

    assert {:error,
            {:stale_row,
             %{
               table: "work_items",
               id: "work-item-1",
               workspace_id: "workspace-1",
               expected_updated_at: "2026-05-19T12:00:00Z",
               actual_updated_at: "2026-05-19T12:05:00Z"
             }}} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "state" => "done",
               "if_updated_at" => "2026-05-19T12:00:00Z"
             })
  end

  test "task.update with only task_id returns existing row as a no-op" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!([%{"id" => "work-item-1", "workspace_id" => "workspace-1", "title" => "T1"}])
      )
    end)

    assert {:ok, %{"id" => "work-item-1", "title" => "T1", "changed_fields" => []}} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1"
             })
  end

  test "task.update ignores manager scheduling-only fields" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!([%{"id" => "work-item-1", "workspace_id" => "workspace-1"}])
      )
    end)

    assert {:ok, %{"changed_fields" => []}} =
             DatabaseTools.execute("task.update", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "next_poll_at" => "2026-05-01T12:00:00Z",
               "poll_cadence_seconds" => 3600,
               "manager_runner_id" => "00000000-0000-0000-0000-000000000001",
               "not_before_at" => "2026-05-01T12:00:00Z",
               "scheduled_reason" => "use schedule",
               "scheduled_by_user_id" => "00000000-0000-0000-0000-000000000002"
             })
  end
end
