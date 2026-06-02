defmodule SymphonyElixir.Gateway.ChatRunnerTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.Gateway.ChatRunner
  alias SymphonyElixir.WorkItem

  defmodule TestAgentInventory do
    def list_agents, do: {:ok, []}
    def get_agent(_agent_id), do: {:error, :not_found}

    def list_credentials("planner-1") do
      {:ok,
       [
         %StoredCredential{
           id: "credential-openai",
           agent_id: "planner-1",
           workspace_id: "workspace-1",
           provider: "openai",
           label: "OpenAI",
           env_var: "OPENAI_API_KEY",
           has_secret: true,
           secret_value: "test-openai-key",
           aliases: ["OPENAI_API_KEY", "api_key"]
         }
       ]}
    end

    def list_credentials(_agent_id), do: {:ok, []}
  end

  defmodule TestSessionResolver do
    def resolve("workspace-1") do
      owner = owner()

      send(owner, {:manager_session_resolved, "workspace-1"})

      {:ok,
       %{
         workspace_id: "workspace-1",
         runner: SymphonyElixir.Gateway.ChatRunnerTest.TestManagerRunner,
         provider: "openai_compatible",
         model: "manager-model",
         on_message: fn message -> send(owner, {:resolver_on_message, message}) end,
         message_recorder_scope: %{
           agent_id: "manager-1",
           workspace_id: "workspace-1",
           user_id: "user-1",
           session_key: "agent:manager-1:main"
         }
       }, %{agent_id: "manager-1"}}
    end

    def resolve("idle-workspace") do
      {:idle, :config_missing, %{status: :idle_awaiting_config}}
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :chat_runner_test_owner)
  end

  defmodule TestManagerRunner do
    def run_turn(session, prompt, %WorkItem{} = work_item) do
      send(owner(), {:manager_run_turn, session, prompt, work_item})

      session.on_message.(%{
        type: :notification,
        payload: %{"text" => "manager event"}
      })

      {:ok, %{"response_id" => "resp-1", "output_text" => "manager response"}}
    end

    def stop_session(session) do
      send(owner(), {:manager_stop_session, session})
      :ok
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :chat_runner_test_owner)
  end

  setup do
    put_app_env(:symphony_elixir, :chat_runner_test_owner, self())
    put_app_env(:symphony_elixir, :gateway_manager_session_resolver, TestSessionResolver)

    :ok
  end

  test "planning agents resolve stored OpenAI credentials for gateway chat turns" do
    put_app_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    put_app_env(:symphony_elixir, :planner_responses_req_options, plug: {Req.Test, __MODULE__})

    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/v1/responses"} ->
          send(test_pid, {:authorization, Plug.Conn.get_req_header(conn, "authorization")})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!(%{
              "id" => "resp-chat",
              "status" => "completed",
              "output" => [
                %{
                  "type" => "message",
                  "role" => "assistant",
                  "content" => [%{"type" => "output_text", "text" => "Planner response"}]
                }
              ]
            })
          )
      end
    end)

    assert :ok = ChatRunner.run(planning_agent(), planner_scope(), "hello planner", "run-planner", self())

    assert_receive {:authorization, ["Bearer test-openai-key"]}

    assert_receive {:gateway_runner_complete, "agent:planner-1:main", "run-planner", {:ok, %{"output_text" => "Planner response"} = result}}

    assert result["model"] == "gpt-test"
    assert result["provider"] == "openai"
    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "manager agents dispatch through SessionResolver and Runner.LlmToolRunner-compatible turns" do
    agent = manager_agent()
    scope = scope("workspace-1")

    assert :ok = ChatRunner.run(agent, scope, "hello manager", "run-1", self())

    assert_received {:manager_session_resolved, "workspace-1"}

    assert_received {:manager_run_turn, session, "hello manager", work_item}
    assert session.provider == "openai_compatible"
    assert session.model == "manager-model"
    assert work_item.id == "agent:manager-1:main"
    assert work_item.identifier == "manager"
    assert work_item.runner_type == "manager"
    assert work_item.metadata == %{"run_id" => "run-1"}

    assert_received {:resolver_on_message, %{payload: %{"text" => "manager event"}} = event}
    assert_received {:gateway_runner_event, "agent:manager-1:main", "run-1", ^event}

    assert_received {:gateway_runner_complete, "agent:manager-1:main", "run-1", {:ok, result}}
    assert result["response_id"] == "resp-1"
    assert result["output_text"] == "manager response"
    assert result["provider"] == "openai_compatible"
    assert result["model"] == "manager-model"

    assert_received {:manager_stop_session, stopped_session}
    assert stopped_session.workspace_id == "workspace-1"

    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "manager agents do not stop caller-owned scheduler sessions" do
    agent = manager_agent()

    scope =
      "workspace-1"
      |> scope()
      |> Map.put(:manager_session, %{
        workspace_id: "workspace-1",
        runner: TestManagerRunner,
        provider: "openai_compatible",
        model: "manager-model",
        on_message: fn message -> send(self(), {:caller_on_message, message}) end
      })

    assert :ok = ChatRunner.run(agent, scope, "hello manager", "run-1", self())

    refute_received {:manager_session_resolved, "workspace-1"}
    assert_received {:manager_run_turn, _session, "hello manager", _work_item}
    refute_received {:manager_stop_session, _session}
    assert_received {:gateway_runner_complete, "agent:manager-1:main", "run-1", {:ok, _result}}
  end

  test "manager resolver idle states fail the gateway run without invoking a runner" do
    agent = manager_agent()
    scope = scope("idle-workspace")

    assert :ok = ChatRunner.run(agent, scope, "hello manager", "run-idle", self())

    assert_received {:gateway_runner_failed, "agent:manager-1:main", "run-idle", {:agent_idle, :config_missing}}

    refute_received {:manager_run_turn, _session, _prompt, _work_item}
    refute_received {:gateway_runner_complete, _session_key, _run_id, _result}
  end

  test "nil manager resolver config falls back to profile resolution instead of crashing" do
    delete_app_env(:symphony_elixir, :gateway_manager_session_resolver)
    put_system_env("SUPABASE_URL", nil)
    put_system_env("LAUNCHER_SUPABASE_URL", nil)
    put_system_env("SUPABASE_SERVICE_ROLE_KEY", nil)
    put_system_env("LAUNCHER_SUPABASE_SERVICE_KEY", nil)

    assert :ok = ChatRunner.run(manager_agent(), scope("workspace-1"), "hello manager", "run-nil", self())

    assert_received {:gateway_runner_failed, "agent:manager-1:main", "run-nil", :supabase_unconfigured}
    refute_received {:manager_session_resolved, _workspace_id}
    refute_received {:manager_run_turn, _session, _prompt, _work_item}
  end

  defp manager_agent do
    %Agent{
      id: "manager-1",
      slug: "manager",
      name: "Manager",
      workspace_id: "workspace-1",
      type: "manager",
      context: "Coordinate the workspace"
    }
  end

  defp planning_agent do
    %Agent{
      id: "planner-1",
      slug: "planner",
      name: "Planner",
      workspace_id: "workspace-1",
      type: "planning",
      context: "Plan the workspace",
      model_settings: %{"model" => "gpt-test", "provider" => "openai"},
      tool_policy: %{}
    }
  end

  defp planner_scope do
    %{
      agent_id: "planner-1",
      workspace_id: "workspace-1",
      user_id: "user-1",
      session_key: "agent:planner-1:main"
    }
  end

  defp scope(workspace_id) do
    %{
      agent_id: "manager-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:manager-1:main"
    }
  end
end
