defmodule SymphonyElixir.PlanningProfileTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.PlanningProfile

  setup do
    put_app_envs(:symphony_elixir,
      planner_database_tools: [
        endpoint: "https://test.supabase.co",
        api_key: "secret"
      ],
      planner_database_tools_req_options: [plug: {Req.Test, __MODULE__}]
    )

    :ok
  end

  test "resolve/1 merges scoped rows over the hard-coded fallback" do
    Req.Test.stub(__MODULE__, fn conn ->
      params = URI.decode_query(conn.query_string)

      case {conn.method, conn.request_path, params["scope_type"], params["scope_id"], params["workspace_id"]} do
        {"GET", "/rest/v1/planning_profile", "eq.agent", "eq.agent-1", "eq.workspace-1"} ->
          row = %{
            "scope_type" => "agent",
            "scope_id" => "agent-1",
            "workspace_id" => "workspace-1",
            "instructions" => "Agent override",
            "definition_of_done" => ["agent done"]
          }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([row]))

        {"GET", "/rest/v1/planning_profile", "eq.workspace", "eq.workspace-1", "eq.workspace-1"} ->
          row = %{
            "scope_type" => "workspace",
            "scope_id" => "workspace-1",
            "workspace_id" => "workspace-1",
            "environment_notes" => "Use local docker compose",
            "repo_boundaries" => %{"default" => "Workspace boundary"}
          }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([row]))

        {"GET", "/rest/v1/planning_profile", "eq.global", "eq.global", "is.null"} ->
          row = %{
            "scope_type" => "global",
            "scope_id" => "global",
            "workspace_id" => nil,
            "instructions" => "Global override",
            "handoff_policy" => %{"include_summary" => true}
          }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([row]))
      end
    end)

    profile =
      PlanningProfile.resolve(%{
        "id" => "agent-1",
        "workspace_id" => "workspace-1"
      })

    assert profile["scope_type"] == "agent"
    assert profile["instructions"] == "Agent override"
    assert profile["environment_notes"] == "Use local docker compose"
    assert profile["definition_of_done"] == ["agent done"]
    assert profile["repo_boundaries"] == %{"default" => "Workspace boundary"}
    assert profile["handoff_policy"]["include_summary"] == true
  end

  test "tool_specs advertise create_update and delete" do
    names = Enum.map(PlanningProfile.tool_specs(), & &1["name"])

    assert names == ["planning_profile.create_update", "planning_profile.delete"]
  end

  test "create_update creates a profile when none exists" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/rest/v1/planning_profile"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          payload = Jason.decode!(body)

          assert payload["workspace_id"] == "workspace-1"
          assert payload["scope_type"] == "workspace"
          assert payload["scope_id"] == "workspace-1"
          assert payload["environment_notes"] == "Use docker compose"
          assert payload["is_active"] == true

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            201,
            Jason.encode!([
              Map.merge(payload, %{"id" => "profile-1", "version" => 1})
            ])
          )
      end
    end)

    assert {:ok, %{"operation" => "created", "profile" => %{"id" => "profile-1"}}} =
             PlanningProfile.execute(
               "planning_profile.create_update",
               %{
                 "workspace_id" => "workspace-1",
                 "scope_type" => "workspace",
                 "scope_id" => "workspace-1",
                 "patch" => %{"environment_notes" => "Use docker compose"}
               }
             )
  end

  test "delete soft-deletes a profile" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "profile-1",
                "scope_type" => "workspace",
                "scope_id" => "workspace-1",
                "workspace_id" => "workspace-1"
              }
            ])
          )

        {"PATCH", "/rest/v1/planning_profile"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          payload = Jason.decode!(body)

          assert payload["is_active"] == false
          assert is_binary(payload["deleted_at"])
          assert payload["deleted_reason"] == "Superseded"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{"id" => "profile-1", "is_active" => false}
            ])
          )
      end
    end)

    assert {:ok, %{"operation" => "deleted"}} =
             PlanningProfile.execute(
               "planning_profile.delete",
               %{
                 "workspace_id" => "workspace-1",
                 "scope_type" => "workspace",
                 "scope_id" => "workspace-1",
                 "reason" => "Superseded"
               }
             )
  end

  test "returns actionable error payloads when the database schema is missing a column" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            400,
            Jason.encode!(%{
              "code" => "PGRST204",
              "message" => "Could not find the 'environment_notes' column of 'planning_profile'"
            })
          )
      end
    end)

    assert {:error, error} =
             PlanningProfile.execute(
               "planning_profile.create_update",
               %{
                 "workspace_id" => "workspace-1",
                 "scope_type" => "workspace",
                 "scope_id" => "workspace-1",
                 "patch" => %{"environment_notes" => "Use docker compose"}
               }
             )

    assert error["message"] =~ "column does not exist"
    assert "environment_notes" in error["allowedFields"]
  end
end
