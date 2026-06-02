defmodule SymphonyElixir.Launcher.RouterHealthAndManagerTest do
  use SymphonyElixir.Launcher.RouterTestSupport

  alias SymphonyElixir.Launcher.RouterTestSupport.{
    ManagerTickChatGateway,
    ManagerTickWorkItemSource,
    RouterTestGatewayConfig
  }

  test "GET /health returns ok" do
    conn =
      conn(:get, "/health")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["ok"] == true
    assert body["service"] == "launcher"
    assert body["lifecycle"]["orchestrator_count"] == 0
    assert Map.has_key?(body["lifecycle"], "latest_failure")
  end

  test "GET /health has json content-type" do
    conn =
      conn(:get, "/health")
      |> call()

    {_, ct} = List.keyfind(conn.resp_headers, "content-type", 0)
    assert ct =~ "application/json"
  end

  test "GET /api/runtime/manager-status returns running scheduler status" do
    workspace_id = "router-manager-status-#{System.unique_integer([:positive])}"
    agent_id = "manager-agent-router"

    assert {:ok, _pid} =
             ManagerSupervisor.ensure_scheduler(workspace_id, agent_id,
               schedule_first_tick: false,
               session: %{
                 workspace_id: workspace_id,
                 runner: SymphonyElixir.Runner.LlmToolRunner,
                 agent_id: agent_id,
                 provider: "openai",
                 model: "gpt-5.2",
                 trace_id: "trc-router-manager-status"
               }
             )

    on_exit(fn -> ManagerSupervisor.stop_scheduler(workspace_id, agent_id) end)

    conn =
      conn(:get, "/api/runtime/manager-status?workspace_id=#{workspace_id}&agent_id=#{agent_id}")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["status"] == "running"
    assert body["workspace_id"] == workspace_id
    assert body["agent_id"] == agent_id
    assert body["missing"] == []
    assert body["provider"] == "openai"
    assert body["model"] == "gpt-5.2"
    assert body["last_decision_count"] == 0
    assert body["last_error"] == nil
    assert body["trace_id"] == "trc-router-manager-status"
  end

  test "POST /api/runtime/manager-tick forces a fresh scheduler tick" do
    workspace_id = "router-manager-tick-#{System.unique_integer([:positive])}"
    agent_id = "manager-agent-tick"

    row = %SymphonyElixir.Manager.WorkItemRow{
      id: Ecto.UUID.generate(),
      identifier: "SMOKE-TICK",
      title: "Router manager tick smoke",
      state: "running",
      workspace_id: workspace_id,
      manager_runner_id: agent_id,
      metadata: %{"reason" => "router test"},
      labels: ["runtime-smoke"],
      next_poll_at: DateTime.add(DateTime.utc_now(), -5, :second),
      created_at: DateTime.utc_now(),
      updated_at: DateTime.utc_now()
    }

    Application.put_env(:symphony_elixir, :test_manager_tick_rows, [row])

    assert {:ok, _pid} =
             ManagerSupervisor.ensure_scheduler(workspace_id, agent_id,
               schedule_first_tick: false,
               work_item_source: ManagerTickWorkItemSource,
               chat_gateway: ManagerTickChatGateway,
               session: %{
                 workspace_id: workspace_id,
                 runner: SymphonyElixir.Runner.LlmToolRunner,
                 agent_id: agent_id,
                 provider: "openai",
                 model: "gpt-5.2",
                 trace_id: "trc-router-manager-tick"
               }
             )

    on_exit(fn -> ManagerSupervisor.stop_scheduler(workspace_id, agent_id) end)

    conn =
      conn(
        :post,
        "/api/runtime/manager-tick?workspace_id=#{workspace_id}&agent_id=#{agent_id}&timeout_ms=5000"
      )
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["status"] == "running"
    assert body["workspace_id"] == workspace_id
    assert body["agent_id"] == agent_id
    assert body["last_decision_count"] == 1
    assert body["last_error"] == nil
    assert body["batch"]["total"] == 1
    assert body["batch"]["ok"] == 1

    assert_received :manager_tick_repo_all
    assert_received {:manager_tick_post_message, _scope, body, _opts}
    assert %{"due_tasks" => [work_item]} = Jason.decode!(body)
    assert work_item["id"] == row.id
  end

  test "GET /api/runtime/manager-status reports idle awaiting config when no manager is configured" do
    workspace_id = "router-manager-missing-#{System.unique_integer([:positive])}"

    conn =
      conn(:get, "/api/runtime/manager-status?workspace_id=#{workspace_id}")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["status"] == "idle_awaiting_config"
    assert body["workspace_id"] == workspace_id
    assert body["missing"] == ["config"]
  end

  test "GET /api/runtime/manager-status reports idle awaiting credential when manager has no credential" do
    workspace_id = "router-manager-cred-#{System.unique_integer([:positive])}"
    agent_id = "manager-agent-cred-#{System.unique_integer([:positive])}"

    Application.put_env(
      :symphony_elixir,
      :launcher_gateway_config_adapter,
      RouterTestGatewayConfig
    )

    Application.put_env(:symphony_elixir, :test_router_manager_gateway, %{
      workspace_id => %{
        "runners" => %{
          "manager" => %{
            "agent_id" => agent_id,
            "provider" => "openai",
            "model" => "gpt-5"
          }
        }
      }
    })

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: agent_id, workspace_id: workspace_id, type: "manager"}
    ])

    conn =
      conn(:get, "/api/runtime/manager-status?workspace_id=#{workspace_id}")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["status"] == "idle_awaiting_credential"
    assert body["workspace_id"] == workspace_id
    assert body["missing"] == ["credential"]
  end

  test "GET /api/runtime/manager-status rejects an agent_id that doesn't match the configured manager" do
    workspace_id = "router-manager-agent-mismatch-#{System.unique_integer([:positive])}"
    configured_agent_id = "manager-agent-real-#{System.unique_integer([:positive])}"
    bogus_agent_id = "manager-agent-bogus-#{System.unique_integer([:positive])}"

    Application.put_env(
      :symphony_elixir,
      :launcher_gateway_config_adapter,
      RouterTestGatewayConfig
    )

    Application.put_env(:symphony_elixir, :test_router_manager_gateway, %{
      workspace_id => %{
        "runners" => %{
          "manager" => %{
            "agent_id" => configured_agent_id,
            "provider" => "openai",
            "model" => "gpt-5",
            "api_key" => "sk-test"
          }
        }
      }
    })

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: configured_agent_id, workspace_id: workspace_id, type: "manager"}
    ])

    conn =
      conn(
        :get,
        "/api/runtime/manager-status?workspace_id=#{workspace_id}&agent_id=#{bogus_agent_id}"
      )
      |> call()

    assert conn.status == 404
    body = Jason.decode!(conn.resp_body)
    assert body["error"] =~ "is not the configured manager"
  end

  test "GET /api/runtime/manager-status requires workspace_id" do
    conn =
      conn(:get, "/api/runtime/manager-status")
      |> call()

    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] =~ "workspace_id is required"
  end

  test "unknown route returns 404" do
    conn =
      conn(:get, "/nonexistent")
      |> call()

    assert conn.status == 404
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "not found"
  end
end
