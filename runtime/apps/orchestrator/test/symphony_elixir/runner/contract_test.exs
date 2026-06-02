defmodule SymphonyElixir.Runner.ContractTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.Contract

  describe "event_names/0" do
    test "freezes the stable event vocabulary" do
      assert Contract.event_names() == [
               :session_started,
               :turn_started,
               :notification,
               :tool_call_started,
               :tool_call_completed,
               :tool_call_failed,
               :command_started,
               :command_output_delta,
               :command_completed,
               :unsupported_tool_call,
               :patch_apply_begin,
               :patch_apply_end,
               :file_change_pending_approval,
               :approval_requested,
               :approval_resolved,
               :command_started,
               :command_output_delta,
               :command_completed,
               :turn_completed,
               :turn_ended_with_error,
               :startup_failed
             ]
    end
  end

  describe "normalize_session/2" do
    test "exposes backend-neutral session keys and preserves adapter state" do
      raw_session = %{
        thread_id: "thread-123",
        workspace: "/tmp/workspace",
        model: "gpt-5.1",
        metadata: %{pid: "1234"},
        port: :backend_port
      }

      assert Contract.normalize_session(raw_session, SymphonyElixir.Runner.Codex) == %{
               runner: "codex",
               session_id: "thread-123",
               workspace: "/tmp/workspace",
               model: "gpt-5.1",
               metadata: %{pid: "1234"},
               backend: raw_session
             }
    end

    test "uses canonical configured runner names for known adapters" do
      assert %{runner: "openclaw"} = Contract.normalize_session(%{}, SymphonyElixir.Runner.OpenClaw)
      assert %{runner: "openclaw_ws"} = Contract.normalize_session(%{}, SymphonyElixir.Runner.OpenClawWS)
      assert %{runner: "computer_use"} = Contract.normalize_session(%{}, SymphonyElixir.Runner.ComputerUse)
      assert %{runner: "local_relay"} = Contract.normalize_session(%{}, SymphonyElixir.Runner.LocalRelay)
    end
  end

  describe "normalize_result/1" do
    test "normalizes successful turn results" do
      artifact_refs = [%{"kind" => "summary", "uri" => "s3://runtime-artifacts/workspaces/workspace-1/runs/run-1/summary.json"}]

      raw_result = %{
        "status" => "completed",
        "output_text" => "done",
        "usage" => %{"input_tokens" => 10},
        "artifact_refs" => artifact_refs
      }

      assert Contract.normalize_result({:ok, raw_result}) ==
               {:ok,
                %{
                  status: :completed,
                  output_text: "done",
                  usage: %{"input_tokens" => 10},
                  artifact_refs: artifact_refs,
                  backend: raw_result
                }}
    end

    test "normalizes retryable and fatal errors" do
      assert Contract.normalize_result({:error, {:retryable, :timeout}}) ==
               {:error, %{status: :retryable_error, reason: :timeout}}

      assert Contract.normalize_result({:error, {:fatal, :bad_request}}) ==
               {:error, %{status: :fatal_error, reason: :bad_request}}

      assert Contract.normalize_result({:error, :unknown_failure}) ==
               {:error, %{status: :fatal_error, reason: :unknown_failure}}
    end
  end

  describe "normalize_event/1" do
    test "accepts stable atom and string event names" do
      timestamp = DateTime.utc_now()

      assert {:ok, %{event: :notification, timestamp: ^timestamp, payload: %{"text" => "hi"}}} =
               Contract.normalize_event(%{event: :notification, timestamp: timestamp, payload: %{"text" => "hi"}})

      assert {:ok, %{event: :patch_apply_end, payload: %{"success" => true}}} =
               Contract.normalize_event(%{event: :patch_apply_end, payload: %{"success" => true}})

      assert {:ok, %{event: :turn_completed, payload: %{}}} =
               Contract.normalize_event(%{"event" => "turn_completed"})
    end

    test "maps legacy Codex event names into stable contract events" do
      assert {:ok, %{event: :turn_ended_with_error}} = Contract.normalize_event(%{event: :turn_failed})
      assert {:ok, %{event: :turn_ended_with_error}} = Contract.normalize_event(%{"event" => "turn_cancelled"})
      assert {:ok, %{event: :approval_requested}} = Contract.normalize_event(%{event: :approval_required})
      assert {:ok, %{event: :approval_resolved}} = Contract.normalize_event(%{"event" => "approval_auto_approved"})
    end

    test "rejects backend events that have not been mapped into the contract vocabulary" do
      assert Contract.normalize_event(%{event: :"codex/event/raw_protocol"}) ==
               {:error, {:unknown_runner_event, :"codex/event/raw_protocol"}}
    end
  end
end
