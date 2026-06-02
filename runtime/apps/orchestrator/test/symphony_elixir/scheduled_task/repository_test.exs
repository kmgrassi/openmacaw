defmodule SymphonyElixir.ScheduledTask.RepositoryTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.ScheduledTask.Repository

  setup do
    System.put_env("SUPABASE_URL", "https://test.supabase.co")
    System.put_env("SUPABASE_SERVICE_ROLE_KEY", "test-api-key")

    on_exit(fn ->
      System.delete_env("SUPABASE_URL")
      System.delete_env("SUPABASE_SERVICE_ROLE_KEY")
    end)

    :ok
  end

  test "reports the generated schema is ready for v1 scheduled task runtime" do
    assert Repository.schema_ready?()

    assert {:scheduled_task_schema_not_ready,
            %{
              scheduled_task: task_missing,
              scheduled_task_run: run_missing
            }} = Repository.schema_error()

    assert task_missing == []
    assert run_missing == []
  end

  test "claim_run includes task scope required by scheduled_task_run inserts" do
    parent = self()
    scheduled_for = ~U[2026-05-15 14:30:00Z]
    started_at = ~U[2026-05-15 14:15:00Z]

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/scheduled_task_run"

      assert URI.decode_query(conn.query_string) == %{
               "on_conflict" => "scheduled_task_id,scheduled_for"
             }

      assert {"prefer", "resolution=ignore-duplicates,return=representation"} in conn.req_headers

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      send(parent, {:claim_payload, payload})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([Map.put(payload, "id", "run-1")]))
    end)

    assert {:ok, %{"id" => "run-1"}} =
             Repository.claim_run(
               %{
                 "id" => "scheduled-task-1",
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "source_work_item_id" => "work-item-1"
               },
               scheduled_for,
               started_at,
               req_options: [plug: {Req.Test, __MODULE__}]
             )

    assert_received {:claim_payload,
                     %{
                       "scheduled_task_id" => "scheduled-task-1",
                       "workspace_id" => "workspace-1",
                       "agent_id" => "agent-1",
                       "source_work_item_id" => "work-item-1",
                       "scheduled_for" => "2026-05-15T14:30:00Z",
                       "status" => "claimed",
                       "started_at" => "2026-05-15T14:15:00Z",
                       "attempt_count" => 1
                     }}
  end

  test "claim_run accepts atom-keyed task maps" do
    parent = self()
    scheduled_for = ~U[2026-05-15 14:30:00Z]
    started_at = ~U[2026-05-15 14:15:00Z]

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)
      send(parent, {:atom_claim_payload, payload})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([Map.put(payload, "id", "run-atom")]))
    end)

    assert {:ok, %{"id" => "run-atom"}} =
             Repository.claim_run(
               %{
                 id: "scheduled-task-atom",
                 workspace_id: "workspace-1",
                 agent_id: "agent-1",
                 source_work_item_id: "work-item-atom"
               },
               scheduled_for,
               started_at,
               req_options: [plug: {Req.Test, __MODULE__}]
             )

    assert_received {:atom_claim_payload,
                     %{
                       "scheduled_task_id" => "scheduled-task-atom",
                       "workspace_id" => "workspace-1",
                       "agent_id" => "agent-1",
                       "source_work_item_id" => "work-item-atom"
                     }}
  end

  test "finish_run orders unique update before applying limit" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "PATCH"
      assert conn.request_path == "/rest/v1/scheduled_task_run"

      assert URI.decode_query(conn.query_string) == %{
               "id" => "eq.run-1",
               "order" => "id",
               "limit" => "1"
             }

      assert {"prefer", "return=representation"} in conn.req_headers

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([Map.put(payload, "id", "run-1")]))
    end)

    assert {:ok, %{"id" => "run-1", "status" => "delivered"}} =
             Repository.finish_run(
               "run-1",
               %{"status" => "delivered"},
               req_options: [plug: {Req.Test, __MODULE__}]
             )
  end

  test "update_task includes updated_at in the patch predicate when requested" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "PATCH"
      assert conn.request_path == "/rest/v1/scheduled_task"

      assert URI.decode_query(conn.query_string) == %{
               "id" => "eq.scheduled-task-1",
               "updated_at" => "eq.2026-05-19T12:00:00Z",
               "order" => "id",
               "limit" => "1"
             }

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([Map.put(payload, "id", "scheduled-task-1")]))
    end)

    assert {:ok, %{"id" => "scheduled-task-1", "enabled" => false}} =
             Repository.update_task(
               "scheduled-task-1",
               %{"enabled" => false},
               match_updated_at: "2026-05-19T12:00:00Z",
               req_options: [plug: {Req.Test, __MODULE__}]
             )
  end
end
