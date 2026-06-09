defmodule SymphonyElixir.Runner.WorkerBridgeRoutingTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.{ClaudeCode, Codex, WorkerBridgeRouting}
  alias SymphonyElixir.WorkItem

  defmodule MockBridge do
    def start_session(params) do
      send(owner(), {:worker_bridge_start_session, params})
      {:ok, %{"id" => "worker-session-1", "status" => "running"}}
    end

    def heartbeat_session(id) do
      send(owner(), {:worker_bridge_heartbeat, id})
      {:ok, %{"id" => id, "status" => "running"}}
    end

    def stop_session(id) do
      send(owner(), {:worker_bridge_stop_session, id})
      {:ok, %{"id" => id, "status" => "stopped"}}
    end

    defp owner do
      Application.fetch_env!(:symphony_elixir, :worker_bridge_routing_test_owner)
    end
  end

  setup do
    put_app_env(:symphony_elixir, :worker_bridge_client, MockBridge)
    put_app_env(:symphony_elixir, :worker_bridge_routing_test_owner, self())
    :ok
  end

  test "detects container execution targets from execution profile metadata" do
    assert WorkerBridgeRouting.container_target?(%{
             "execution_profile" => %{
               "executionTarget" => %{"kind" => "container", "metadata" => %{"sessionId" => "s-1"}}
             }
           })

    assert WorkerBridgeRouting.container_target?(%{
             "execution_profile" => %{
               "adapter_config" => %{"execution_target" => "container"}
             }
           })

    refute WorkerBridgeRouting.container_target?(%{
             "execution_profile" => %{
               "executionTarget" => %{"kind" => "local_helper"}
             }
           })
  end

  test "codex container sessions start through worker bridge" do
    config = %{
      "command" => "codex app-server",
      "execution_profile" => %{
        "runner_kind" => "codex",
        "adapter_config" => %{"execution_target" => "container"}
      }
    }

    assert {:ok, session} = Codex.start_session(config, "/tmp/workspace")
    assert session.worker_bridge
    assert session.session_id == "worker-session-1"

    assert_received {:worker_bridge_start_session, params}
    assert params["kind"] == "codex"
    assert params["cwd"] == "/tmp/workspace"
    assert params["command"] == "codex app-server"
    assert params["execution_target"] == "container"

    work_item = work_item()

    assert {:error, {:fatal, {:worker_bridge_turn_transport_unavailable, _message}}} =
             Codex.run_turn(session, "do the work", work_item)

    assert_received {:worker_bridge_heartbeat, "worker-session-1"}
    assert :ok = Codex.stop_session(session)
    assert_received {:worker_bridge_stop_session, "worker-session-1"}
  end

  test "claude_code container sessions start through worker bridge with bridge command" do
    workspace = Path.join(Config.settings!().workspace.root, "claude-code-container-workspace")
    File.mkdir_p!(workspace)

    config = %{
      "bridge_command" => "node bridge.js",
      "api_key" => "test-key",
      "execution_profile" => %{
        "runner_kind" => "claude_code",
        "executionTarget" => %{"kind" => "container", "metadata" => %{"sessionId" => "s-1"}}
      }
    }

    assert {:ok, session} = ClaudeCode.start_session(config, workspace)
    assert session.worker_bridge

    assert_received {:worker_bridge_start_session, params}
    assert {:ok, canonical_workspace} = SymphonyElixir.PathSafety.canonicalize(workspace)
    assert params["kind"] == "claude_code"
    assert params["cwd"] == canonical_workspace
    assert params["command"] == "node bridge.js"
    assert params["execution_target"] == "container"
  end

  defp work_item do
    %WorkItem{
      id: "wi-bridge",
      identifier: "BRIDGE-1",
      title: "Bridge route",
      description: "Route through worker bridge",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{}
    }
  end
end
