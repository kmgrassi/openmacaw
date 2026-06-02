defmodule SymphonyElixir.Runner.Planner.LocalRelayTest do
  use SymphonyElixir.Runner.PlannerTestSupport

  alias SymphonyElixir.Planner.ModelClient.LocalRelay

  test "start_session accepts atom-keyed planner config" do
    on_message = fn _event -> :ok end

    assert {:ok, session} =
             LocalRelay.start_session(
               %{
                 workspace_id: "workspace-1",
                 model: "qwen",
                 max_tool_iterations: "4",
                 on_message: on_message,
                 planning_profile: %{},
                 agent: %{
                   id: "agent-1",
                   workspace_id: "workspace-1",
                   tool_policy: %{},
                   model_settings: %{model: "agent-model"}
                 }
               },
               nil
             )

    assert session.workspace_id == "workspace-1"
    assert session.model == "qwen"
    assert session.max_tool_iterations == 4
    assert session.on_message == on_message
  end

  test "runs local relay planner with runtime-owned planner tools" do
    test_pid = self()
    helper = start_local_planner_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "local", model: "qwen"}]
    })

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"GET", "/rest/v1/plan"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "plan-1", "workspace_id" => "workspace-1"}]))

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:local_task_payload, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            201,
            Jason.encode!([
              %{
                "id" => "work-item-local",
                "workspace_id" => "workspace-1",
                "plan_id" => "plan-1",
                "title" => "Local relay task"
              }
            ])
          )
      end
    end)

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "execution_profile" => %{"provider" => "local", "model" => "qwen"},
                 "model" => "qwen",
                 "agent" => %{
                   id: "agent-1",
                   workspace_id: "workspace-1",
                   type: "planning",
                   tool_policy: %{}
                 }
               },
               nil
             )

    assert session.model_client == SymphonyElixir.Planner.ModelClient.LocalRelay

    assert {:ok, %{"output_text" => "Created the task locally."}} =
             Planner.run_turn(session, "Create one task", %WorkItem{
               id: "work-1",
               identifier: "PLAN-1",
               title: "Plan work"
             })

    assert_received {:local_dispatch,
                     %{
                       "runner_kind" => "planner",
                       "tool_calling_mode" => "cloud_managed",
                       "provider_tool_specs" => provider_tool_specs
                     }}

    assert "task_create" in Enum.map(provider_tool_specs, &get_in(&1, ["function", "name"]))

    assert_received {:local_task_payload,
                     %{
                       "workspace_id" => "workspace-1",
                       "plan_id" => "plan-1",
                       "title" => "Local relay task",
                       "source" => "planner"
                     }}

    assert_received {:local_continuation, %{"messages" => messages, "tool_call_iteration" => 1}}
    assert Enum.any?(messages, &match?(%{"role" => "tool", "name" => "task.create"}, &1))
  end
end
