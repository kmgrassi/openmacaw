defmodule SymphonyElixir.LocalRuntime.DiagnosticsTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRelay.Presence
  alias SymphonyElixir.LocalRuntime.Diagnostics

  setup do
    clear_presence()
    on_exit(fn -> Application.delete_env(:symphony_elixir, :local_runtime_diagnostics_source) end)
    :ok
  end

  test "reports disconnected helpers when no local helper is registered" do
    payload = Diagnostics.health_payload(%{})

    assert payload.ok == false
    assert payload.status == "degraded"
    assert payload.reason == "helper_disconnected"
    assert payload.helpers == []
  end

  test "reports ready local runners with capability snapshots and endpoint fingerprints" do
    Application.put_env(:symphony_elixir, :local_runtime_diagnostics_source, fn ->
      %{
        helpers: [
          %{
            workspace_id: "workspace-1",
            machine_id: "machine-1",
            connected: true,
            runners: [
              %{
                runner_kind: "openai_compatible",
                provider: "ollama",
                model: "qwen2.5-coder:latest",
                endpoint: "http://user:secret@127.0.0.1:11434/v1?api_key=secret",
                capability_snapshot_id: "cap-snapshot-1",
                capabilities: %{
                  streaming: true,
                  json_mode: true,
                  api_key: "must-redact"
                }
              }
            ]
          }
        ]
      }
    end)

    payload =
      Diagnostics.health_payload(%{
        "workspace_id" => "workspace-1",
        "target_runner_kind" => "openai_compatible",
        "model" => "qwen2.5-coder:latest",
        "required_capabilities" => "streaming,json_mode"
      })

    assert payload.ok == true
    assert payload.reason == "ready"

    [helper] = payload.helpers
    [runner] = helper.runners

    assert helper.workspace_id == "workspace-1"
    assert runner.runner_kind == "openai_compatible"
    assert runner.provider == "ollama"
    assert runner.model == "qwen2.5-coder:latest"
    assert runner.capability_snapshot_id == "cap-snapshot-1"
    assert runner.capabilities["streaming"] == true
    assert runner.capabilities["api_key"] == "[REDACTED]"
    assert runner.endpoint_fingerprint =~ ~r/^sha256:[a-f0-9]{64}$/
    refute inspect(payload) =~ "secret@127.0.0.1"
  end

  test "uses live local relay presence when no diagnostics source is configured" do
    assert :ok =
             Presence.register(%{
               workspace_id: "workspace-live",
               machine_id: "machine-live",
               connection_pid: self(),
               runner_kinds: ["openai_compatible"],
               runners: [
                 %{
                   runner_kind: "openai_compatible",
                   provider: "ollama",
                   model: "qwen3-coder:30b",
                   capabilities: %{streaming: true}
                 }
               ],
               metadata: %{}
             })

    payload =
      Diagnostics.health_payload(%{
        "workspace_id" => "workspace-live",
        "target_runner_kind" => "openai_compatible",
        "model" => "qwen3-coder:30b"
      })

    assert payload.ok == true
    assert payload.reason == "ready"

    [helper] = payload.helpers
    assert helper.workspace_id == "workspace-live"
    assert helper.machine_id == "machine-live"
  end

  test "distinguishes unregistered targets, missing models, capabilities, and busy runners" do
    Application.put_env(:symphony_elixir, :local_runtime_diagnostics_source, [
      %{
        workspace_id: "workspace-1",
        machine_id: "machine-1",
        connected: true,
        runners: [
          %{
            runner_kind: "openai_compatible",
            provider: "ollama",
            models: ["qwen2.5-coder:latest"],
            busy: true,
            capabilities: %{streaming: true, json_mode: true}
          }
        ]
      }
    ])

    assert %{reason: "target_runner_not_registered"} =
             Diagnostics.health_payload(%{"workspace_id" => "workspace-1", "target_runner_kind" => "codex"})

    assert %{reason: "model_unavailable"} =
             Diagnostics.health_payload(%{
               "workspace_id" => "workspace-1",
               "target_runner_kind" => "openai_compatible",
               "model" => "missing"
             })

    assert %{reason: "capability_mismatch"} =
             Diagnostics.health_payload(%{
               "workspace_id" => "workspace-1",
               "target_runner_kind" => "openai_compatible",
               "required_capabilities" => ["tool_calls"]
             })

    assert %{reason: "local_runner_busy"} =
             Diagnostics.health_payload(%{"workspace_id" => "workspace-1", "target_runner_kind" => "openai_compatible"})
  end

  test "limits busy and failure diagnostics to the filtered runner scope" do
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
          },
          %{
            runner_kind: "codex",
            provider: "openai_codex",
            model: "gpt-5.3-codex",
            busy: true,
            capabilities: %{streaming: true}
          }
        ]
      }
    ])

    assert %{ok: true, reason: "ready"} =
             Diagnostics.health_payload(%{
               "workspace_id" => "workspace-1",
               "target_runner_kind" => "openai_compatible",
               "model" => "qwen2.5-coder:latest"
             })

    assert %{ok: false, reason: "local_runner_busy"} =
             Diagnostics.health_payload(%{"workspace_id" => "workspace-1", "target_runner_kind" => "codex"})
  end

  test "emits structured local run fields and normalizes unsafe failure reasons" do
    log =
      capture_log(fn ->
        Diagnostics.log_event(:warning, :local_run_failed, %{
          workspace_id: "workspace-1",
          agent_id: "agent-1",
          run_id: "run-1",
          session_id: "session-1",
          machine_id: "machine-1",
          runner_kind: "local_relay",
          target_runner_kind: "openai_compatible",
          provider: "ollama",
          model: "qwen2.5-coder:latest",
          reason: "raw helper stacktrace",
          capabilities: %{streaming: true, endpoint_url: "http://localhost:11434/v1"}
        })
      end)

    payload = decode_logged_json!(log)

    assert payload["event"] == "local_run_failed"
    assert payload["workspace_id"] == "workspace-1"
    assert payload["agent_id"] == "agent-1"
    assert payload["run_id"] == "run-1"
    assert payload["session_id"] == "session-1"
    assert payload["machine_id"] == "machine-1"
    assert payload["runner_kind"] == "local_relay"
    assert payload["target_runner_kind"] == "openai_compatible"
    assert payload["provider"] == "ollama"
    assert payload["model"] == "qwen2.5-coder:latest"
    assert payload["typed_failure_reason"] == "local_runner_protocol_error"
    assert payload["capability_snapshot"]["streaming"] == true
    assert payload["capability_snapshot"]["endpoint_url"] == "[REDACTED]"
  end

  defp decode_logged_json!(log) do
    log
    |> String.split("\n", trim: true)
    |> Enum.find_value(fn line ->
      case Regex.run(~r/(\{.*\})/, line) do
        [_, json] -> Jason.decode!(json)
        _ -> nil
      end
    end)
  end

  defp clear_presence do
    if Process.whereis(Presence) do
      Enum.each(Presence.list(), fn presence ->
        Presence.offline(presence.workspace_id, presence.machine_id)
      end)
    end
  end
end
