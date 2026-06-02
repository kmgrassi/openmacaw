defmodule SymphonyElixir.RuntimeLogTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.RuntimeLog

  test "emits JSON event logs and redacts sensitive fields" do
    log =
      capture_log(fn ->
        RuntimeLog.log(:info, :request_failed, %{
          trace_id: "trc-test",
          agent_id: "agent-1",
          api_key: "secret",
          nested: %{authorization: "Bearer token"}
        })
      end)

    payload = decode_logged_json!(log)

    assert payload["event"] == "request_failed"
    assert payload["trace_id"] == "trc-test"
    assert payload["agent_id"] == "agent-1"
    assert payload["api_key"] == "[REDACTED]"
    assert payload["nested"]["authorization"] == "[REDACTED]"
    assert is_binary(payload["timestamp"])
  end

  test "normalizes atom and string event and field names" do
    log =
      capture_log(fn ->
        RuntimeLog.log(:info, "Tool-Call Completed", %{
          "trace-id" => "trc-test",
          requestId: "req-1",
          nested: %{"toolCallId" => "call-1"}
        })
      end)

    payload = decode_logged_json!(log)

    assert payload["event"] == "tool_call_completed"
    assert payload["trace_id"] == "trc-test"
    assert payload["request_id"] == "req-1"
    assert payload["nested"]["tool_call_id"] == "call-1"
  end

  test "adds missing required fields for representative high-value events" do
    log =
      capture_log(fn ->
        RuntimeLog.log(:info, :tool_call_completed, %{
          trace_id: "trc-test",
          run_id: "run-1",
          turn_id: "turn-1",
          tool_call_id: "call-1"
        })
      end)

    payload = decode_logged_json!(log)

    assert RuntimeLog.required_fields_for(:tool_call_completed) == [
             "trace_id",
             "run_id",
             "turn_id",
             "tool_call_id",
             "tool_name",
             "duration_ms"
           ]

    assert payload["missing_required_fields"] == ["tool_name", "duration_ms"]
  end

  test "redacts nested sensitive fields in lists" do
    log =
      capture_log(fn ->
        RuntimeLog.log(:info, :nested_redaction, %{
          steps: [
            %{name: "ok"},
            %{"credentials" => [%{token: "secret-token"}]}
          ]
        })
      end)

    payload = decode_logged_json!(log)

    assert payload["steps"] == [
             %{"name" => "ok"},
             %{"credentials" => "[REDACTED]"}
           ]
  end

  test "converts non JSON safe values before encoding" do
    ref = make_ref()

    log =
      capture_log(fn ->
        RuntimeLog.log(:info, :non_json_safe, %{
          pid: self(),
          ref: ref,
          reason: {:error, :timeout},
          callback: fn -> :ok end
        })
      end)

    payload = decode_logged_json!(log)

    assert payload["pid"] =~ "#PID<"
    assert payload["ref"] =~ "#Reference<"
    assert payload["reason"] == ["error", "timeout"]
    assert payload["callback"] =~ "#Function<"
  end

  test "timed helper returns the operation result and logs duration" do
    log =
      capture_log(fn ->
        assert RuntimeLog.timed(:info, :operation_completed, %{trace_id: "trc-test"}, fn -> :ok end) == :ok
      end)

    payload = decode_logged_json!(log)

    assert payload["event"] == "operation_completed"
    assert payload["trace_id"] == "trc-test"
    assert is_integer(payload["duration_ms"])
  end

  test "with_error_log logs error tuple context without changing the result" do
    log =
      capture_log(fn ->
        assert RuntimeLog.with_error_log(:error, :operation_failed, %{trace_id: "trc-test"}, fn ->
                 {:error, {:timeout, :db}}
               end) == {:error, {:timeout, :db}}
      end)

    payload = decode_logged_json!(log)

    assert payload["event"] == "operation_failed"
    assert payload["trace_id"] == "trc-test"
    assert payload["error_code"] == "operation_failed"
    assert payload["reason"] == "{:timeout, :db}"
  end

  test "with_operation_trace_id binds the trace id in the process dictionary" do
    refute Process.get(:symphony_trace_id)

    result =
      RuntimeLog.with_operation_trace_id("trc-operation", fn ->
        Process.get(:symphony_trace_id)
      end)

    assert result == "trc-operation"
    refute Process.get(:symphony_trace_id)
  end

  test "with_operation_trace_id generates a trace id when given nil" do
    captured =
      RuntimeLog.with_operation_trace_id(nil, fn ->
        Process.get(:symphony_trace_id)
      end)

    assert is_binary(captured)
    assert String.starts_with?(captured, "trc_")
    refute Process.get(:symphony_trace_id)
  end

  test "with_operation_trace_id restores the previous value on exit" do
    Process.put(:symphony_trace_id, "trc-outer")

    try do
      assert RuntimeLog.with_operation_trace_id("trc-inner", fn ->
               Process.get(:symphony_trace_id)
             end) == "trc-inner"

      assert Process.get(:symphony_trace_id) == "trc-outer"
    after
      Process.delete(:symphony_trace_id)
    end
  end

  test "with_operation_trace_id restores previous value when fun raises" do
    Process.put(:symphony_trace_id, "trc-outer")

    try do
      assert_raise RuntimeError, "boom", fn ->
        RuntimeLog.with_operation_trace_id("trc-inner", fn ->
          raise "boom"
        end)
      end

      assert Process.get(:symphony_trace_id) == "trc-outer"
    after
      Process.delete(:symphony_trace_id)
    end
  end

  test "extracts trace ids from direct and W3C trace headers" do
    assert RuntimeLog.trace_id_from_headers([{"x-trace-id", "trc-123"}]) == "trc-123"

    assert RuntimeLog.trace_id_from_headers(%{
             "traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
           }) == "4bf92f3577b34da6a3ce929d0e0e4736"
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
end
