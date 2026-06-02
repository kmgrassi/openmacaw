defmodule SymphonyElixir.Planner.DatabaseToolsPlanUpdateTest do
  use SymphonyElixir.Planner.DatabaseToolsCase

  test "plan.update reads existing row, shallow merges metadata, and returns changed fields" do
    Req.Test.stub(__MODULE__, fn conn ->
      case conn.method do
        "GET" ->
          assert conn.request_path == "/rest/v1/plan"

          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.plan-1",
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
                "id" => "plan-1",
                "workspace_id" => "workspace-1",
                "status" => "active",
                "metadata" => %{"owner" => "planner", "unchanged" => true}
              }
            ])
          )

        "PATCH" ->
          assert conn.request_path == "/rest/v1/plan"

          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.plan-1",
                   "workspace_id" => "eq.workspace-1",
                   "order" => "id.asc",
                   "limit" => "1"
                 }

          assert {"prefer", "return=representation"} in conn.req_headers

          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert Jason.decode!(body) == %{
                   "status" => "deleted",
                   "metadata" => %{
                     "owner" => "planner",
                     "unchanged" => true,
                     "deleted_by" => "planner"
                   }
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "plan-1",
                "status" => "deleted",
                "metadata" => %{
                  "owner" => "planner",
                  "unchanged" => true,
                  "deleted_by" => "planner"
                }
              }
            ])
          )
      end
    end)

    assert {:ok,
            %{
              "id" => "plan-1",
              "status" => "deleted",
              "changed_fields" => ["status", "metadata"],
              "metadata" => %{
                "owner" => "planner",
                "unchanged" => true,
                "deleted_by" => "planner"
              }
            }} =
             DatabaseTools.execute("plan.update", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "status" => "deleted",
               "metadata" => %{"deleted_by" => "planner"},
               "ignored" => "not patched"
             })
  end

  test "plan.update returns existing row with empty changed fields for no-op updates" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/plan"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!([
          %{
            "id" => "plan-1",
            "workspace_id" => "workspace-1",
            "status" => "active",
            "metadata" => %{"owner" => "planner"}
          }
        ])
      )
    end)

    assert {:ok,
            %{
              "id" => "plan-1",
              "status" => "active",
              "metadata" => %{"owner" => "planner"},
              "changed_fields" => []
            }} =
             DatabaseTools.execute("plan.update", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "status" => "active",
               "metadata" => %{}
             })
  end

  test "plan.update rejects null for non-nullable fields before reading" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("null validation should fail before any database request")
    end)

    assert {:error, {:invalid_null, "status is non-nullable"}} =
             DatabaseTools.execute("plan.update", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "status" => nil
             })

    assert {:error, {:invalid_null, "metadata is non-nullable"}} =
             DatabaseTools.execute("plan.update", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "metadata" => nil
             })
  end

  test "plan.update accepts if_updated_at as an optimistic concurrency guard" do
    Req.Test.stub(__MODULE__, fn conn ->
      case conn.method do
        "GET" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "plan-1",
                "workspace_id" => "workspace-1",
                "status" => "active",
                "updated_at" => "2026-05-19T12:00:00Z"
              }
            ])
          )

        "PATCH" ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.plan-1",
                   "workspace_id" => "eq.workspace-1",
                   "updated_at" => "eq.2026-05-19T12:00:00Z",
                   "order" => "id.asc",
                   "limit" => "1"
                 }

          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert Jason.decode!(body) == %{"status" => "deleted"}

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "plan-1",
                "status" => "deleted",
                "updated_at" => "2026-05-19T12:00:01Z"
              }
            ])
          )
      end
    end)

    assert {:ok,
            %{
              "id" => "plan-1",
              "status" => "deleted",
              "updated_at" => "2026-05-19T12:00:01Z",
              "changed_fields" => ["status"]
            }} =
             DatabaseTools.execute("plan.update", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "status" => "deleted",
               "if_updated_at" => "2026-05-19T12:00:00Z"
             })
  end

  test "plan.update rejects stale if_updated_at values" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/plan"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "plan-1",
                "workspace_id" => "workspace-1",
                "status" => "active",
                "updated_at" => "2026-05-19T12:05:00Z"
              }
            ])
          )

        {"PATCH", "/rest/v1/plan"} ->
          assert URI.decode_query(conn.query_string)["updated_at"] == "eq.2026-05-19T12:00:00Z"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([]))
      end
    end)

    assert {:error,
            {:stale_row,
             %{
               table: "plan",
               id: "plan-1",
               workspace_id: "workspace-1",
               expected_updated_at: "2026-05-19T12:00:00Z",
               actual_updated_at: "2026-05-19T12:05:00Z"
             }}} =
             DatabaseTools.execute("plan.update", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1",
               "status" => "deleted",
               "if_updated_at" => "2026-05-19T12:00:00Z"
             })
  end

  test "plan.delete soft-deletes by setting plan status to deleted" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "PATCH"
      assert conn.request_path == "/rest/v1/plan"

      assert URI.decode_query(conn.query_string) == %{
               "id" => "eq.plan-1",
               "workspace_id" => "eq.workspace-1",
               "order" => "id.asc",
               "limit" => "1"
             }

      assert {"prefer", "return=representation"} in conn.req_headers

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      assert Jason.decode!(body) == %{"status" => "deleted"}

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "plan-1", "status" => "deleted"}]))
    end)

    assert {:ok, %{"id" => "plan-1", "status" => "deleted"}} =
             DatabaseTools.execute("plan.delete", %{
               "workspace_id" => "workspace-1",
               "plan_id" => "plan-1"
             })
  end
end
