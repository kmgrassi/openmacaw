defmodule SymphonyElixir.Runner.LocalRelayTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.Runner.LocalRelay
  alias SymphonyElixir.WorkItem

  setup do
    Registry.reset!()
    on_exit(fn -> Registry.reset!() end)
    :ok
  end

  test "starts without a workspace and checks helper availability" do
    assert LocalRelay.requires_workspace?() == false
    assert {:error, :local_runtime_offline} = LocalRelay.ping(%{"workspace_id" => "workspace-1"})

    Registry.register(%{workspace_id: "workspace-1", machine_id: "machine-1", runners: ["openai_compatible"]})
    assert :ok = LocalRelay.ping(%{"workspace_id" => "workspace-1"})

    assert {:ok, session} =
             LocalRelay.start_session(
               %{
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "target_runner_kind" => "openai_compatible",
                 "provider" => "ollama",
                 "model" => "qwen2.5-coder:latest"
               },
               nil
             )

    assert session.runner == "local_relay"
    assert session.target_runner_kind == "openai_compatible"
    assert session.model == "qwen2.5-coder:latest"
  end

  test "dispatches through the registry and returns mock helper completion" do
    parent = self()
    helper = start_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen"}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-1",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "on_message" => fn event -> send(parent, {:runner_event, event}) end
        },
        nil
      )

    assert {:ok, result} = LocalRelay.run_turn(session, "Say hi", build_work_item())
    assert result["status"] == "completed"
    assert result["output_text"] == "hello"
    assert result["usage"] == %{"total_tokens" => 3}

    assert_receive {:dispatch_frame,
                    %{
                      "type" => "dispatch",
                      "workspace_id" => "workspace-1",
                      "agent_id" => "agent-1",
                      "target_runner_kind" => "openai_compatible",
                      "model" => "qwen",
                      "prompt" => "Say hi"
                    }}

    assert_receive {:runner_event, %{event: :turn_started}}
    assert_receive {:runner_event, %{event: :notification, payload: %{"params" => %{"textDelta" => "hel"}}}}
    assert_receive {:runner_event, %{event: :notification, payload: %{"params" => %{"textDelta" => "lo"}}}}
    assert_receive {:runner_event, %{event: :notification, payload: %{"method" => "usage.updated", "params" => %{"usage" => %{"total_tokens" => 3}}}}}
    assert_receive {:runner_event, %{event: :turn_completed, payload: %{"method" => "run.completed", "params" => %{"output" => "hello", "usage" => %{"total_tokens" => 3}}}}}
  end

  test "maps normalized local model progress events without duplicate completion" do
    parent = self()

    helper =
      spawn_link(fn ->
        receive do
          {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
            Registry.progress(correlation_id, %{"type" => "progress", "event" => "usage.updated", "usage" => %{"total_tokens" => 5}})
            Registry.progress(correlation_id, %{"type" => "progress", "event" => "run.completed", "output" => "done", "usage" => %{"total_tokens" => 5}})
            Registry.complete(correlation_id, %{"output_text" => "done", "usage" => %{"total_tokens" => 5}})
        end
      end)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", model: "qwen"}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-1",
          "model" => "qwen",
          "on_message" => fn event -> send(parent, {:runner_event, event}) end
        },
        nil
      )

    assert {:ok, %{"output_text" => "done"}} = LocalRelay.run_turn(session, "prompt", build_work_item())
    assert_receive {:runner_event, %{event: :notification, payload: %{"method" => "usage.updated"}}}
    assert_receive {:runner_event, %{event: :turn_completed, payload: %{"method" => "run.completed"}}}
    refute_receive {:runner_event, %{event: :turn_completed}}, 20
  end

  test "maps offline, busy, timeout, and helper error states to typed runner errors" do
    {:ok, session} = LocalRelay.start_session(%{"workspace_id" => "workspace-1", "timeout_ms" => 20}, nil)
    assert {:error, {:retryable, :local_runtime_offline}} = LocalRelay.run_turn(session, "prompt", build_work_item())

    Registry.register(%{workspace_id: "workspace-1", machine_id: "machine-1", runners: ["openai_compatible"]})
    assert {:ok, _correlation_id, _helper} = Registry.dispatch("workspace-1", "openai_compatible", %{"correlation_id" => "busy"})
    assert {:error, {:retryable, :local_runner_busy}} = LocalRelay.run_turn(session, "prompt", build_work_item())
    Registry.complete("busy", %{})

    helper = start_error_helper("model_not_found", false)
    Registry.register(%{workspace_id: "workspace-1", machine_id: "machine-1", pid: helper, runners: ["openai_compatible"]})
    assert {:error, {:fatal, :model_not_found}} = LocalRelay.run_turn(session, "prompt", build_work_item())

    helper = start_error_helper("endpoint_unreachable", false)
    Registry.register(%{workspace_id: "workspace-1", machine_id: "machine-1", pid: helper, runners: ["openai_compatible"]})
    assert {:error, {:fatal, :endpoint_unreachable}} = LocalRelay.run_turn(session, "prompt", build_work_item())

    helper = start_timeout_helper()
    Registry.register(%{workspace_id: "workspace-1", machine_id: "machine-1", pid: helper, runners: ["openai_compatible"]})
    assert {:error, {:retryable, :local_runner_timeout}} = LocalRelay.run_turn(session, "prompt", build_work_item())
  end

  test "returns typed model and capability errors before dispatch" do
    parent = self()
    helper = start_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "ollama",
          model: "qwen",
          capabilities: %{json_mode: false}
        }
      ]
    })

    {:ok, missing_model_session} =
      LocalRelay.start_session(%{"workspace_id" => "workspace-1", "model" => "missing"}, nil)

    assert {:error, {:fatal, :model_not_found}} =
             LocalRelay.run_turn(missing_model_session, "prompt", build_work_item())

    {:ok, capability_session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-1",
          "model" => "qwen",
          "capability_requirements" => %{"json_mode" => true}
        },
        nil
      )

    assert {:error, {:fatal, :capability_missing}} =
             LocalRelay.run_turn(capability_session, "prompt", build_work_item())

    refute_received {:dispatch_frame, _frame}
  end

  test "accepts a requested model from any advertised runner registration" do
    parent = self()
    helper = start_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [
        %{runner_kind: "openai_compatible", provider: "ollama", model: "first-model"},
        %{runner_kind: "openai_compatible", provider: "ollama", model: "second-model"}
      ]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{"workspace_id" => "workspace-1", "model" => "second-model"},
        nil
      )

    assert {:ok, result} = LocalRelay.run_turn(session, "prompt", build_work_item())
    assert result["output_text"] == "hello"

    assert_receive {:dispatch_frame, %{"model" => "second-model"}}
  end

  test "matches capability keys without creating atoms" do
    parent = self()
    helper = start_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", model: "qwen", capabilities: %{json_mode: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{"workspace_id" => "workspace-1", "model" => "qwen", "capability_requirements" => %{"json_mode" => true}},
        nil
      )

    assert {:ok, result} = LocalRelay.run_turn(session, "prompt", build_work_item())
    assert result["output_text"] == "hello"
  end

  test "unknown existing atom-shaped error strings fall back to protocol error" do
    helper = start_error_helper("timeout", false)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: ["openai_compatible"]
    })

    {:ok, session} = LocalRelay.start_session(%{"workspace_id" => "workspace-1"}, nil)

    assert {:error, {:fatal, :local_runner_protocol_error}} =
             LocalRelay.run_turn(session, "prompt", build_work_item())
  end

  defp start_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:dispatch_frame, frame})
          Registry.progress(correlation_id, %{"type" => "progress", "event" => "message.delta", "text" => "hel"})
          Registry.progress(correlation_id, %{"type" => "progress", "event" => "message.delta", "text" => "lo"})
          Registry.complete(correlation_id, %{"output_text" => "hello", "usage" => %{"total_tokens" => 3}})
      end
    end)
  end

  defp start_error_helper(error_code, retryable) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          Registry.error(correlation_id, %{"error_code" => error_code, "retryable" => retryable})
      end
    end)
  end

  defp start_timeout_helper do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, _frame} ->
          receive do
            {:local_relay_cancel, _frame} -> :ok
          end
      end
    end)
  end

  defp build_work_item do
    %WorkItem{
      id: "wi-#{System.unique_integer([:positive])}",
      identifier: "TEST-1",
      title: "Test work item",
      description: "A test work item",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{"session_id" => "session-1"}
    }
  end
end
