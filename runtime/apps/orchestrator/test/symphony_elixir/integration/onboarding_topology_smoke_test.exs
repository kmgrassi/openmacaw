defmodule SymphonyElixir.Integration.OnboardingTopologySmokeTest do
  @moduledoc """
  Onboarding-shaped smoke for the default agent topology.

  The platform onboarding flow creates planning, coding, and manager agents
  from one provider/model set, then lands the user in planning. This test keeps
  the runtime contract honest without a helper binary, real model, or network:

    * planning dispatch includes the expected default-agent context
    * plan.create and task.create round-trip through runtime-owned tools
    * planner review events expose IDs used by the coding handoff
    * launcher injects the reviewed handoff envelope into a coding-agent launch

  The final automatic "planner starts coding" bridge is platform-owned today;
  this smoke verifies the runtime boundaries on either side of that bridge.
  """

  use SymphonyElixir.TestSupport

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Launcher.EngineInstance
  alias SymphonyElixir.Launcher.Server
  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.Runner.Planner
  alias SymphonyElixir.WorkItem

  @workspace_id "workspace-onboarding"
  @provider "local"
  @model "qwen"

  defmodule TestAgentInventory do
    @behaviour SymphonyElixir.AgentInventory

    alias SymphonyElixir.AgentInventory.Agent

    def list_agents do
      {:ok, Application.get_env(:symphony_elixir, :onboarding_topology_agents, [])}
    end

    def get_agent(agent_id) do
      Application.get_env(:symphony_elixir, :onboarding_topology_agents, [])
      |> Enum.find(&(&1.id == agent_id))
      |> case do
        %Agent{} = agent -> {:ok, agent}
        nil -> {:error, :not_found}
      end
    end

    def list_credentials(_agent_id), do: {:ok, []}
  end

  setup do
    Req.Test.set_req_test_to_shared(%{})
    Registry.reset!()

    Application.put_env(:symphony_elixir, :planner_responses_req_options, plug: {Req.Test, __MODULE__})

    Application.put_env(:symphony_elixir, :planner_database_tools,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    Application.put_env(:symphony_elixir, :planner_database_tools_req_options, plug: {Req.Test, __MODULE__})
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    Application.put_env(:symphony_elixir, :onboarding_topology_agents, default_agents())

    Application.put_env(:symphony_elixir, :agent_launch_template, %{
      "tracker" => %{"kind" => "memory"},
      "execution_profile" => %{
        "runner_kind" => "local_relay",
        "provider" => @provider,
        "model" => @model
      },
      "workspace_id" => @workspace_id
    })

    Application.put_env(
      :symphony_elixir,
      :launcher_engine_instance_dispatcher,
      fn work ->
        work.()
        :ok
      end
    )

    Application.put_env(:symphony_elixir, :launcher_engine_instance_req_options, plug: {Req.Test, EngineInstance})

    Application.put_env(:symphony_elixir, :launcher_engine_instance,
      endpoint: "https://test.supabase.co/rest/v1",
      api_key: "test-api-key",
      table: "engine_instance",
      host: "test-host"
    )

    state_dir = Path.join(System.tmp_dir!(), "onboarding_topology_#{System.unique_integer([:positive])}")
    File.mkdir_p!(state_dir)

    {:ok, config_registry} = SymphonyElixir.Launcher.ConfigRegistry.start_link()

    {:ok, supervisor} =
      DynamicSupervisor.start_link(
        name: SymphonyElixir.Launcher.DynamicSupervisor,
        strategy: :one_for_one
      )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :planner_responses_req_options)
      Application.delete_env(:symphony_elixir, :planner_database_tools)
      Application.delete_env(:symphony_elixir, :planner_database_tools_req_options)
      Application.delete_env(:symphony_elixir, :agent_inventory_adapter)
      Application.delete_env(:symphony_elixir, :onboarding_topology_agents)
      Application.delete_env(:symphony_elixir, :agent_launch_template)
      Application.delete_env(:symphony_elixir, :launcher_engine_instance_dispatcher)
      Application.delete_env(:symphony_elixir, :launcher_engine_instance_req_options)
      Application.delete_env(:symphony_elixir, :launcher_engine_instance)
      Registry.reset!()
      safe_stop(supervisor)
      safe_stop(config_registry)
      File.rm_rf!(state_dir)
    end)

    %{state_dir: state_dir, supervisor: supervisor}
  end

  test "planner creates reviewed plan and task, then coding launch receives the handoff envelope", ctx do
    test_pid = self()
    start_launcher(ctx)
    start_planner_helper(test_pid)
    stub_planner_database(test_pid)
    stub_engine_instance()

    on_message = fn message -> send(test_pid, {:planner_event, message}) end

    {:ok, session} =
      Planner.start_session(
        %{
          "execution_profile" => %{"provider" => @provider, "model" => @model},
          "model" => @model,
          "agent" => planning_agent(),
          on_message: on_message
        },
        nil
      )

    assert {:ok, %{"output_text" => "Plan and task are ready for coding."}} =
             Planner.run_turn(session, "Create a small first task", %WorkItem{id: "work-planner", identifier: "PLAN-1"})

    assert_received {:planner_dispatch, planner_frame}
    assert planner_frame["workspace_id"] == @workspace_id
    assert planner_frame["agent_id"] == "planning-agent"
    assert planner_frame["runner_kind"] == "planner"
    assert planner_frame["target_runner_kind"] == "openai_compatible"
    assert planner_frame["provider"] == @provider
    assert planner_frame["model"] == @model

    provider_tool_names = Enum.map(planner_frame["provider_tool_specs"], &get_in(&1, ["function", "name"]))
    assert "plan_create" in provider_tool_names
    assert "task_create" in provider_tool_names

    assert_received {:plan_post, %{"workspace_id" => @workspace_id, "name" => "First onboarding plan"}}

    assert_received {:work_items_post,
                     %{
                       "workspace_id" => @workspace_id,
                       "plan_id" => "plan-onboarding",
                       "title" => "Verify default coding handoff",
                       "source" => "planner"
                     }}

    assert_received {:planner_continuation, plan_continuation}
    assert_received {:planner_continuation, task_continuation}

    plan_review = review_event(plan_continuation, "plan.create")
    task_review = review_event(task_continuation, "task.create")

    assert plan_review == %{
             "type" => "planner.plan.created",
             "payload" => %{
               "plan_id" => "plan-onboarding",
               "workspace_id" => @workspace_id,
               "name" => "First onboarding plan",
               "description" => "Plan created from onboarding smoke"
             }
           }

    assert %{
             "type" => "planner.task.created",
             "payload" => %{
               "task_id" => "task-onboarding",
               "plan_id" => "plan-onboarding",
               "workspace_id" => @workspace_id,
               "name" => "Verify default coding handoff"
             }
           } = task_review

    assert_received {:planner_event, %{event: :tool_call_completed, payload: %{"tool_name" => "plan.create"}}}
    assert_received {:planner_event, %{event: :tool_call_completed, payload: %{"tool_name" => "task.create"}}}
    assert_received {:planner_event, %{event: :turn_completed, message: "Plan and task are ready for coding."}}

    assert {:ok, coding_runtime} =
             Server.start_agent("coding-agent", %{
               "source" => "planner",
               "approved_plan_id" => "plan-onboarding",
               "selected_task_ids" => ["task-onboarding"]
             })

    assert coding_runtime.agent_id == "coding-agent"
    assert coding_runtime.type == "coding"

    assert coding_runtime.config["plan_handoff"] == %{
             "source" => "planner",
             "approved_plan_id" => "plan-onboarding",
             "selected_task_ids" => ["task-onboarding"]
           }
  end

  defp start_launcher(%{state_dir: state_dir, supervisor: supervisor}) do
    starter = fn opts ->
      id = Keyword.fetch!(opts, :id)

      child_spec = %{
        id: :"onboarding_topology_#{id}",
        start: {Elixir.Agent, :start_link, [fn -> %{id: id} end]},
        restart: :temporary
      }

      DynamicSupervisor.start_child(supervisor, child_spec)
    end

    {:ok, pid} = Server.start_link(start_port: 19_500, starter: starter, heartbeat_ms: :infinity, state_dir: state_dir)
    ExUnit.Callbacks.on_exit(fn -> safe_stop(pid) end)
    pid
  end

  defp start_planner_helper(parent) do
    helper =
      spawn_link(fn ->
        receive do
          {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
            send(parent, {:planner_dispatch, frame})

            Registry.tool_call_request(correlation_id, %{
              "type" => "tool_call_request",
              "tool_calls" => [
                %{
                  "id" => "call-plan",
                  "name" => "plan_create",
                  "arguments" => %{
                    "workspace_id" => @workspace_id,
                    "name" => "First onboarding plan",
                    "description" => "Plan created from onboarding smoke"
                  }
                }
              ]
            })

            receive_continuation(parent)

            Registry.tool_call_request(correlation_id, %{
              "type" => "tool_call_request",
              "tool_calls" => [
                %{
                  "id" => "call-task",
                  "name" => "task_create",
                  "arguments" => %{
                    "workspace_id" => @workspace_id,
                    "plan_id" => "plan-onboarding",
                    "name" => "Verify default coding handoff",
                    "description" => "Exercise the runtime handoff contract"
                  }
                }
              ]
            })

            receive_continuation(parent)
            Registry.complete(correlation_id, %{"output_text" => "Plan and task are ready for coding."})
        end
      end)

    Registry.register(%{
      workspace_id: @workspace_id,
      machine_id: "machine-onboarding",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: @provider, model: @model}]
    })
  end

  defp receive_continuation(parent) do
    receive do
      {:local_relay_frame, continuation} -> send(parent, {:planner_continuation, continuation})
    end
  end

  defp stub_planner_database(test_pid) do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          json(conn, 200, [])

        {"POST", "/rest/v1/plan"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:plan_post, Jason.decode!(body)})

          json(conn, 201, [
            %{
              "id" => "plan-onboarding",
              "workspace_id" => @workspace_id,
              "name" => "First onboarding plan",
              "description" => "Plan created from onboarding smoke"
            }
          ])

        {"GET", "/rest/v1/plan"} ->
          json(conn, 200, [%{"id" => "plan-onboarding", "workspace_id" => @workspace_id}])

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:work_items_post, Jason.decode!(body)})

          json(conn, 201, [
            %{
              "id" => "task-onboarding",
              "workspace_id" => @workspace_id,
              "plan_id" => "plan-onboarding",
              "title" => "Verify default coding handoff",
              "description" => "Exercise the runtime handoff contract"
            }
          ])
      end
    end)
  end

  defp stub_engine_instance do
    Req.Test.stub(EngineInstance, fn conn ->
      case conn.method do
        "GET" -> json(conn, 200, [])
        "PATCH" -> json(conn, 200, [])
        "POST" -> json(conn, 201, [])
      end
    end)
  end

  defp review_event(continuation, tool_name) do
    continuation
    |> Map.fetch!("messages")
    |> Enum.find_value(fn
      %{"role" => "tool", "name" => ^tool_name, "content" => content} ->
        content
        |> Jason.decode!()
        |> Map.fetch!("_review_events")
        |> List.first()

      _message ->
        nil
    end)
  end

  defp default_agents do
    [
      planning_agent(),
      coding_agent(),
      manager_agent()
    ]
  end

  defp planning_agent do
    default_agent("planning-agent", "Planning Agent", "planning")
  end

  defp coding_agent do
    default_agent("coding-agent", "Coding Agent", "coding")
  end

  defp manager_agent do
    default_agent("manager-agent", "Manager Agent", "manager")
  end

  defp default_agent(id, name, type) do
    %Agent{
      id: id,
      name: name,
      workspace_id: @workspace_id,
      project_id: "project-onboarding",
      type: type,
      model_settings: %{"provider" => @provider, "model" => @model},
      tool_policy: %{},
      has_credentials: true
    }
  end

  defp json(conn, status, payload) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(status, Jason.encode!(payload))
  end

  defp safe_stop(pid) when is_pid(pid) do
    if Process.alive?(pid) do
      try do
        GenServer.stop(pid, :normal, 5_000)
      catch
        :exit, _ -> :ok
      end
    end
  end

  defp safe_stop(_pid), do: :ok
end
