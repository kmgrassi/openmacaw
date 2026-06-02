defmodule SymphonyElixir.Planner.DatabaseToolsPlanCreateTest do
  use SymphonyElixir.Planner.DatabaseToolsCase

  test "plan.create writes workspace-scoped plan payload and returns the created row" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/plan"
      assert {"prefer", "return=representation"} in conn.req_headers

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert Jason.decode!(body) == %{
               "workspace_id" => "workspace-1",
               "name" => "Launch plan",
               "description" => "Break down launch work",
               "type" => "release",
               "is_ongoing" => true,
               "intent" => "ship_release",
               "default_model" => "gpt-5.1",
               "default_runner_kind" => "codex",
               "metadata" => %{
                 "audience" => "runtime",
                 "default_repository" => "parallel-agent-runtime"
               }
             }

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        201,
        Jason.encode!([%{"id" => "plan-1", "workspace_id" => "workspace-1"}])
      )
    end)

    assert {:ok, plan} =
             DatabaseTools.execute("plan.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Launch plan",
               "description" => "Break down launch work",
               "type" => "release",
               "is_ongoing" => true,
               "intent" => "ship_release",
               "default_model" => "gpt-5.1",
               "default_runner_kind" => "codex",
               "default_repository" => "parallel-agent-runtime",
               "metadata" => %{"audience" => "runtime"}
             })

    assert %{"id" => "plan-1", "workspace_id" => "workspace-1"} = plan

    assert [
             %{
               "type" => "planner.plan.created",
               "payload" => %{
                 "plan_id" => "plan-1",
                 "workspace_id" => "workspace-1",
                 "name" => "Launch plan",
                 "description" => "Break down launch work"
               }
             }
           ] = plan["_review_events"]
  end

  test "plan.create defaults workspace from tool context" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/plan"

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert Jason.decode!(body) == %{
               "workspace_id" => "workspace-1",
               "name" => "Launch plan",
               "default_runner_kind" => "codex"
             }

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        201,
        Jason.encode!([%{"id" => "plan-1", "workspace_id" => "workspace-1"}])
      )
    end)

    assert {:ok, %{"id" => "plan-1"}} =
             DatabaseTools.execute("plan.create", %{"name" => "Launch plan"}, workspace_id: "workspace-1")
  end

  test "plan.create applies default repository and runner kind from tool context" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/plan"

      {:ok, body, conn} = Plug.Conn.read_body(conn)

      assert Jason.decode!(body) == %{
               "workspace_id" => "workspace-1",
               "name" => "Launch plan",
               "default_runner_kind" => "codex",
               "metadata" => %{"default_repository" => "parallel-agent-runtime"}
             }

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "plan-1"}]))
    end)

    assert {:ok, %{"id" => "plan-1"}} =
             DatabaseTools.execute(
               "plan.create",
               %{"workspace_id" => "workspace-1", "name" => "Launch plan"},
               default_repository: "parallel-agent-runtime",
               default_runner_kind: "codex"
             )
  end

  test "plan.create rejects non-object metadata" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when metadata is invalid")
    end)

    assert {:error, {:invalid_argument, "metadata", "must be an object"}} =
             DatabaseTools.execute("plan.create", %{
               "workspace_id" => "workspace-1",
               "name" => "Launch plan",
               "metadata" => "invalid"
             })
  end
end
