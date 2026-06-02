defmodule SymphonyElixir.Planner.DatabaseToolsTaskScheduleTest do
  use SymphonyElixir.Planner.DatabaseToolsCase

  test "task.schedule patches timing fields and writes an audit event" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
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
                   "next_poll_at" => "2026-05-01T12:00:00Z",
                   "poll_cadence_seconds" => 3600
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "work-item-1",
                "workspace_id" => "workspace-1",
                "next_poll_at" => "2026-05-01T12:00:00Z",
                "poll_cadence_seconds" => 3600
              }
            ])
          )

        {"POST", "/rest/v1/event_log"} ->
          assert URI.decode_query(conn.query_string) == %{"select" => "id,kind,payload"}
          assert {"prefer", "return=representation"} in conn.req_headers

          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert Jason.decode!(body) == %{
                   "workspace_id" => "workspace-1",
                   "work_item_id" => "work-item-1",
                   "kind" => "work_item.timing_updated",
                   "source" => "planner_tool",
                   "payload" => %{
                     "next_poll_at" => "2026-05-01T12:00:00Z",
                     "poll_cadence_seconds" => 3600,
                     "reason" => "start after design review"
                   }
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))
      end
    end)

    assert {:ok,
            %{
              "id" => "work-item-1",
              "next_poll_at" => "2026-05-01T12:00:00Z",
              "poll_cadence_seconds" => 3600
            }} =
             DatabaseTools.execute("task.schedule", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "next_poll_at" => "2026-05-01T12:00:00Z",
               "poll_cadence_seconds" => 3600,
               "reason" => "start after design review"
             })
  end

  test "task.schedule can clear timed polling" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert Jason.decode!(body) == %{"next_poll_at" => nil}

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([%{"id" => "work-item-1", "next_poll_at" => nil}])
          )

        {"POST", "/rest/v1/event_log"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))
      end
    end)

    assert {:ok, %{"id" => "work-item-1", "next_poll_at" => nil}} =
             DatabaseTools.execute("task.schedule", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1",
               "next_poll_at" => nil
             })
  end

  test "task.schedule skips audit event when scoped update matches no rows" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"PATCH", "/rest/v1/work_items"} ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.missing-task",
                   "workspace_id" => "eq.workspace-1",
                   "order" => "id.asc",
                   "limit" => "1"
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([]))

        {"POST", "/rest/v1/event_log"} ->
          flunk("event_log should not be written when no work_items row was updated")
      end
    end)

    assert {:error, {:task_not_found, "missing-task", "workspace-1"}} =
             DatabaseTools.execute("task.schedule", %{
               "workspace_id" => "workspace-1",
               "task_id" => "missing-task",
               "next_poll_at" => "2026-05-01T12:00:00Z"
             })
  end
end
