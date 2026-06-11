defmodule SymphonyElixir.Runner.ObservabilityTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias SymphonyElixir.Runner.Observability

  test "classifies provider status failures with request ids" do
    response = %Req.Response{
      status: 429,
      headers: [{"x-request-id", "req-123"}],
      body: %{"error" => %{"message" => "slow down"}}
    }

    assert %{
             event: "model_call_failed",
             provider: "openai",
             model: "gpt-test",
             status: 429,
             status_code: 429,
             provider_status: 429,
             provider_request_id: "req-123",
             error_code: "provider_rate_limited",
             retryable: true,
             duration_ms: 42,
             attempt: 2,
             retry_count: 1,
             runner_kind: "manager",
             credential_id_suffix: "12345678",
             reason: "slow down"
           } =
             Observability.provider_status_failure(
               429,
               response.body,
               response,
               %{provider: "openai", model: "gpt-test", attempt: 2, runner_kind: "manager", credential_id: "cred-12345678"},
               42
             )
  end

  test "classifies provider request timeouts" do
    assert %{
             event: "model_call_failed",
             error_code: "provider_timeout",
             retryable: true,
             duration_ms: 100
           } =
             Observability.provider_request_failure(
               %Mint.TransportError{reason: :timeout},
               %{provider: "openai", model: "gpt-test"},
               100
             )
  end

  test "classifies Anthropic refusal blocks as retryable content refusals" do
    body = %{
      "type" => "message",
      "content" => [
        %{"type" => "refusal", "refusal" => "I cannot help with that request."}
      ],
      "stop_reason" => "end_turn"
    }

    assert Observability.provider_content_refusal?(body)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "anthropic",
             model: "claude-test"
           } =
             Observability.provider_content_refusal_failure(
               body,
               %{provider: "anthropic", model: "claude-test"},
               17
             )
  end

  test "classifies Anthropic top-level refusal stop reasons as content refusals" do
    body = %{
      "type" => "message",
      "content" => [%{"type" => "text", "text" => ""}],
      "stop_reason" => "refusal"
    }

    assert Observability.provider_content_refusal?(body)
  end

  test "classifies OpenAI content_filter finish reasons as retryable content refusals" do
    body = %{
      "choices" => [
        %{"finish_reason" => "content_filter", "message" => %{"content" => ""}}
      ]
    }

    assert Observability.provider_content_refusal?(body)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "openai",
             model: "gpt-test"
           } =
             Observability.provider_content_refusal_failure(
               body,
               %{provider: "openai", model: "gpt-test"},
               23
             )
  end

  test "classifies OpenClaw content-policy 4xx responses as retryable content refusals" do
    body = %{"error" => %{"code" => "content_policy_violation", "message" => "blocked by content policy"}}

    assert Observability.content_policy_status_failure?(403, body)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "openclaw",
             runner_kind: "openclaw"
           } =
             Observability.provider_status_failure(
               403,
               body,
               nil,
               %{provider: "openclaw", runner_kind: "openclaw"},
               31
             )
  end

  test "classifies ComputerUse content-policy 4xx responses as retryable content refusals" do
    body = %{"message" => "request refused by safety policy"}

    assert Observability.content_policy_status_failure?(422, body)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "computer_use",
             runner_kind: "computer_use"
           } =
             Observability.provider_status_failure(
               422,
               body,
               nil,
               %{provider: "computer_use", runner_kind: "computer_use"},
               31
             )
  end

  test "classifies Codex AppServer refusal-shaped RPC errors as retryable content refusals" do
    reason =
      {:response_error,
       %{
         "code" => "content_filter",
         "message" => "model refused the prompt",
         "data" => %{"type" => "content_policy"}
       }}

    assert Observability.codex_content_refusal_error?(reason)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "openai_codex",
             runner_kind: "codex"
           } =
             Observability.provider_error_failure(
               reason,
               %{provider: "openai_codex", runner_kind: "codex"},
               44
             )
  end

  test "emits redacted structured model call lifecycle logs" do
    log =
      capture_log(fn ->
        context = %{
          provider: "openai",
          model: "gpt-test",
          runner_kind: "planner",
          credential_id: "cred-secret-abcdef12",
          credential_scope: "workspace",
          trace_id: "trace-1",
          workspace_id: "workspace-1",
          agent_id: "agent-1",
          attempt: 3
        }

        Observability.log_model_call_started(context)
        Observability.log_model_call_completed(context, 25, status_code: 200, provider_request_id: "req-1")
      end)

    entries =
      Regex.scan(~r/\{.*\}/, log)
      |> Enum.map(fn [line] -> Jason.decode!(line) end)

    assert Enum.any?(entries, &(&1["event"] == "model_call_started"))

    assert Enum.any?(entries, fn entry ->
             entry["event"] == "model_call_completed" and
               entry["provider"] == "openai" and
               entry["runner_kind"] == "planner" and
               entry["credential_id_suffix"] == "abcdef12" and
               entry["credential_scope"] == "workspace" and
               entry["retry_count"] == 2 and
               entry["status_code"] == 200 and
               entry["provider_request_id"] == "req-1"
           end)
  end

  test "classifies tool policy denials and preserves execution metadata" do
    result = %{
      "success" => false,
      "output" =>
        Jason.encode!(%{
          "error" => %{
            "message" => "Dynamic tool \"linear_graphql\" is not allowed by this agent's tool policy."
          }
        })
    }

    assert %{
             "success" => false,
             "tool_name" => "linear_graphql",
             "tool_call_id" => "call-1",
             "error_code" => "tool_denied",
             "retryable" => false,
             "duration_ms" => 7,
             "attempt" => 1
           } =
             Observability.classify_tool_result(
               result,
               %{tool_name: "linear_graphql", tool_call_id: "call-1"},
               7
             )
  end

  test "classifies manager invalid argument tool failures" do
    result = %{
      "success" => false,
      "error" => "invalid_arguments",
      "output" => Jason.encode!(%{"error" => "invalid_arguments", "reason" => "missing work_item_id"})
    }

    assert %{"error_code" => "tool_invalid_args", "retryable" => false} =
             Observability.classify_tool_result(result, %{tool_name: "snooze"}, 3)
  end
end
