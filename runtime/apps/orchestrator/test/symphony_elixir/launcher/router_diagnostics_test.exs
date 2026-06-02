defmodule SymphonyElixir.Launcher.RouterDiagnosticsTest do
  use SymphonyElixir.Launcher.RouterTestSupport

  test "GET /api/v1/diagnostic/agent/:id probes one agent" do
    Application.put_env(:symphony_elixir, :test_agent_probe_results, %{
      "agent-broken" => {:error, :credential_missing, %{credential_alias: "default"}}
    })

    conn =
      conn(:get, "/api/v1/diagnostic/agent/agent-broken?workspace_id=workspace-1")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["agent_id"] == "agent-broken"
    assert body["runner_kind"] == "codex"
    assert body["status"] == "not_ready"
    assert body["reason"] == "credential_missing"
    assert body["details"] == %{"credential_alias" => "default"}
  end

  test "GET /api/v1/diagnostic/agent/:id requires workspace_id" do
    conn =
      conn(:get, "/api/v1/diagnostic/agent/agent-1")
      |> call()

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"] == "workspace_id is required"
  end

  test "GET /api/v1/diagnostic/workspace/:workspace_id/agents returns batch probe results" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-ready", workspace_id: "workspace-1"},
      %Agent{id: "agent-broken", workspace_id: "workspace-1"},
      %Agent{id: "agent-slow", workspace_id: "workspace-1"},
      %Agent{id: "agent-other", workspace_id: "workspace-2"}
    ])

    Application.put_env(:symphony_elixir, :test_agent_probe_results, %{
      "agent-broken" => {:error, :credential_missing, %{credential_alias: "default"}},
      "agent-slow" => {:sleep, 11_000}
    })

    conn =
      conn(:get, "/api/v1/diagnostic/workspace/workspace-1/agents")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["workspace_id"] == "workspace-1"

    assert [
             %{"agent_id" => "agent-ready", "runner_kind" => "codex", "status" => "ready"},
             %{
               "agent_id" => "agent-broken",
               "runner_kind" => "codex",
               "status" => "not_ready",
               "reason" => "credential_missing",
               "details" => %{"credential_alias" => "default"}
             },
             %{"agent_id" => "agent-slow", "runner_kind" => "codex", "status" => "timeout"}
           ] = body["agents"]
  end

  test "GET /api/v1/diagnostic/workspace/:workspace_id/agents includes shared runner_kind values by agent type" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-planning", workspace_id: "workspace-1", type: "planning"},
      %Agent{id: "agent-coding", workspace_id: "workspace-1", type: "coding"},
      %Agent{id: "agent-manager", workspace_id: "workspace-1", type: "manager"},
      %Agent{id: "agent-custom", workspace_id: "workspace-1", type: "custom"}
    ])

    conn =
      conn(:get, "/api/v1/diagnostic/workspace/workspace-1/agents")
      |> call()

    assert conn.status == 200

    assert [
             %{"agent_id" => "agent-planning", "runner_kind" => "planner", "status" => "ready"},
             %{"agent_id" => "agent-coding", "runner_kind" => "codex", "status" => "ready"},
             %{"agent_id" => "agent-manager", "runner_kind" => "llm_tool_runner", "status" => "ready"},
             %{"agent_id" => "agent-custom", "runner_kind" => "openclaw_ws", "status" => "ready"}
           ] = Jason.decode!(conn.resp_body)["agents"]
  end

  test "GET /api/v1/diagnostic/workspace/:workspace_id/agents returns an empty list for zero agents" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-other", workspace_id: "workspace-2"}
    ])

    conn =
      conn(:get, "/api/v1/diagnostic/workspace/workspace-1/agents")
      |> call()

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"workspace_id" => "workspace-1", "agents" => []}
  end

  test "workspace diagnostic probes no more than five agents concurrently" do
    Application.put_env(:symphony_elixir, :agent_diagnostic_options,
      per_agent_timeout_ms: 1_000,
      aggregate_timeout_ms: 2_000
    )

    {:ok, counter} = Elixir.Agent.start_link(fn -> %{current: 0, max: 0} end)
    Application.put_env(:symphony_elixir, :test_agent_probe_counter, counter)

    agents =
      Enum.map(1..8, fn index ->
        %Agent{id: "agent-#{index}", workspace_id: "workspace-1"}
      end)

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, agents)

    Application.put_env(
      :symphony_elixir,
      :test_agent_probe_results,
      Map.new(agents, fn %Agent{id: id} -> {id, {:sleep, 100}} end)
    )

    conn =
      conn(:get, "/api/v1/diagnostic/workspace/workspace-1/agents")
      |> call()

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["agents"] |> length() == 8
    assert Elixir.Agent.get(counter, & &1.max) <= 5
  end

  test "GET /agents/:id returns 404 when missing" do
    conn =
      conn(:get, "/agents/missing")
      |> call()

    assert conn.status == 404
    assert Jason.decode!(conn.resp_body)["error"] == "agent not found"
  end

  test "GET /agents/:id/diagnostics reports inventory and stopped runtime blockers" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        status: "ready",
        has_credentials: true
      }
    ])

    conn =
      conn(:get, "/agents/agent-1/diagnostics")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert body["ok"] == false
    assert body["status"] == "degraded"
    assert body["agent"]["id"] == "agent-1"
    assert body["agent"]["workspace_id"] == "workspace-1"
    assert body["agent"]["has_credentials"] == true
    assert body["launcher"]["status"] == "reachable"
    assert body["runtime"]["status"] == "not_running"
    assert body["local_runtime"]["status"] == "skipped"

    assert [
             %{
               "code" => "runtime_unavailable",
               "layer" => "runtime",
               "message" => "Runtime is not healthy"
             }
           ] = body["blockers"]
  end

  test "GET /agents/:id/diagnostics includes runtime and local relay readiness" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{
      "tracker" => %{"kind" => "memory"},
      "execution_profile" => %{
        "runner_kind" => "local_relay",
        "provider" => "openai_compatible",
        "model" => "qwen2.5-coder:latest"
      }
    })

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        model_settings: %{"primary" => "qwen2.5-coder:latest"},
        has_credentials: true
      }
    ])

    Application.put_env(:symphony_elixir, :local_runtime_diagnostics_source, [
      %{
        workspace_id: "workspace-1",
        machine_id: "machine-1",
        connected: true,
        runners: [
          %{
            runner_kind: "openai_compatible",
            provider: "ollama",
            model: "qwen2.5-coder:latest",
            capabilities: %{streaming: true}
          }
        ]
      }
    ])

    assert {:ok, _orchestrator} = Server.start_agent("agent-1")

    conn =
      conn(:get, "/agents/agent-1/diagnostics")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert body["ok"] == true
    assert body["blockers"] == []
    assert body["runtime"]["status"] == "running"
    assert body["runtime"]["execution_profile"]["runner_kind"] == "local_relay"
    assert body["runtime"]["execution_profile"]["provider"] == "openai_compatible"
    assert body["runtime"]["execution_profile"]["model"] == "qwen2.5-coder:latest"
    assert body["local_runtime"]["status"] == "healthy"
    assert [%{"machine_id" => "machine-1"}] = body["local_runtime"]["helpers"]
  end

  test "GET /agents/:id/diagnostics uses LocalRelay default target runner kind when provider is local" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{
      "tracker" => %{"kind" => "memory"},
      "execution_profile" => %{
        "runner_kind" => "local_relay",
        "provider" => "local",
        "model" => "qwen2.5-coder:latest"
      }
    })

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        model_settings: %{"primary" => "qwen2.5-coder:latest"},
        has_credentials: true
      }
    ])

    Application.put_env(:symphony_elixir, :local_runtime_diagnostics_source, [
      %{
        workspace_id: "workspace-1",
        machine_id: "machine-1",
        connected: true,
        runners: [
          %{
            runner_kind: "openai_compatible",
            provider: "ollama",
            model: "qwen2.5-coder:latest",
            capabilities: %{streaming: true}
          }
        ]
      }
    ])

    assert {:ok, _orchestrator} = Server.start_agent("agent-1")

    conn =
      conn(:get, "/agents/agent-1/diagnostics")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert body["ok"] == true
    assert body["blockers"] == []
    assert body["local_runtime"]["status"] == "healthy"
  end
end
