defmodule SymphonyElixir.Planner.DatabaseToolsReadAndConfigTest do
  use SymphonyElixir.Planner.DatabaseToolsCase

  test "plan.read and task.read include id and workspace predicates" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      send(
        test_pid,
        {:request, conn.method, conn.request_path, URI.decode_query(conn.query_string)}
      )

      response =
        case conn.request_path do
          "/rest/v1/plan" -> [%{"id" => "plan-1"}]
          "/rest/v1/work_items" -> [%{"id" => "work-item-1", "title" => "Work item", "state" => "todo"}]
        end

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(response))
    end)

    assert {:ok, %{"id" => "plan-1"}} =
             DatabaseTools.execute("plan.read", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1"
             })

    assert {:ok, %{"id" => "work-item-1"}} =
             DatabaseTools.execute("task.read", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1"
             })

    assert {:ok, %{"id" => "work-item-1", "dispatch" => %{"reason" => "missing_route"}}} =
             DatabaseTools.execute("task.status", %{
               "workspace_id" => "workspace-1",
               "task_id" => "work-item-1"
             })

    assert_received {:request, "GET", "/rest/v1/plan",
                     %{
                       "id" => "eq.plan-1",
                       "workspace_id" => "eq.workspace-1",
                       "order" => "id.asc",
                       "limit" => "1"
                     }}

    assert_received {:request, "GET", "/rest/v1/work_items",
                     %{
                       "id" => "eq.work-item-1",
                       "workspace_id" => "eq.workspace-1",
                       "order" => "id.asc",
                       "limit" => "1"
                     }}

    assert_received {:request, "GET", "/rest/v1/work_items",
                     %{
                       "id" => "eq.work-item-1",
                       "workspace_id" => "eq.workspace-1",
                       "order" => "id.asc",
                       "limit" => "1"
                     }}
  end

  test "validates required arguments before making HTTP requests" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("HTTP should not be called when required arguments are missing")
    end)

    assert {:error, {:missing_argument, "workspace_id"}} =
             DatabaseTools.execute("plan.create", %{"name" => "Launch plan"})

    assert {:error, {:missing_update_fields, _allowed}} =
             DatabaseTools.execute("plan.update", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1"
             })

    assert {:error, {:missing_argument, "next_poll_at"}} =
             DatabaseTools.execute("task.schedule", %{
               "workspace_id" => "workspace-1",
               "task_id" => "task-1"
             })

    assert {:error, {:invalid_argument, "next_poll_at", "must be ISO-8601 or null"}} =
             DatabaseTools.execute("task.schedule", %{
               "workspace_id" => "workspace-1",
               "task_id" => "task-1",
               "next_poll_at" => "tomorrow"
             })
  end

  test "returns a normal error when Supabase connection config is missing" do
    Application.delete_env(:symphony_elixir, :planner_database_tools)
    previous_url = System.get_env("SUPABASE_URL")
    previous_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")
    System.delete_env("SUPABASE_URL")
    System.delete_env("SUPABASE_SERVICE_ROLE_KEY")

    on_exit(fn ->
      restore_env("SUPABASE_URL", previous_url)
      restore_env("SUPABASE_SERVICE_ROLE_KEY", previous_key)
    end)

    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("HTTP should not be called when Supabase config is missing")
    end)

    assert {:error, {:missing_supabase_config, message}} =
             DatabaseTools.execute("plan.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Launch plan"
             })

    assert message =~ "Supabase PostgREST endpoint is not configured"
  end
end
