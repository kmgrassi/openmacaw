defmodule SymphonyElixir.Provider.AnthropicMessagesTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Provider.AnthropicMessages

  setup do
    %{req_options: [plug: {Req.Test, __MODULE__}]}
  end

  test "posts an Anthropic Messages request and normalizes the turn result", %{req_options: req_options} do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/v1/messages"
      assert Plug.Conn.get_req_header(conn, "x-api-key") == ["sk-ant-test"]
      assert Plug.Conn.get_req_header(conn, "anthropic-version") == ["2023-06-01"]

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      request = Jason.decode!(body)
      send(test_pid, {:request, request})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "type" => "message",
          "id" => "msg_123",
          "model" => "claude-sonnet-4-5",
          "content" => [
            %{"type" => "text", "text" => "Need repo context."},
            %{
              "type" => "tool_use",
              "id" => "toolu_123",
              "name" => "repository_read",
              "input" => %{"path" => "README.md"}
            }
          ],
          "usage" => %{"input_tokens" => 10, "output_tokens" => 6},
          "stop_reason" => "tool_use"
        })
      )
    end)

    assert {:ok, result} =
             AnthropicMessages.start_turn(
               %{
                 "base_url" => "https://api.anthropic.com/v1/messages",
                 "model" => "claude-sonnet-4-5",
                 "credential" => %{"value" => "sk-ant-test"}
               },
               [%{role: "user", content: "Inspect the repo"}],
               [
                 %{
                   "name" => "repository_read",
                   "description" => "Read a repository file",
                   "inputSchema" => %{"type" => "object", "properties" => %{"path" => %{"type" => "string"}}}
                 }
               ],
               req_options: req_options,
               system: "You are a planning agent."
             )

    assert_received {:request, request}
    assert request["model"] == "claude-sonnet-4-5"
    assert request["system"] == "You are a planning agent."
    assert request["messages"] == [%{"role" => "user", "content" => "Inspect the repo"}]
    assert [%{"name" => "repository_read", "input_schema" => input_schema}] = request["tools"]
    assert input_schema["properties"]["path"]["type"] == "string"

    assert result.provider == "anthropic"
    assert result.model == "claude-sonnet-4-5"
    assert result.id == "msg_123"
    assert result.output_text == "Need repo context."
    assert result.finish_reason == "tool_calls"

    assert Enum.map(result.tool_calls, &Map.take(&1, [:id, :name, :arguments])) == [
             %{id: "toolu_123", name: "repository_read", arguments: %{"path" => "README.md"}}
           ]

    assert result.usage == %{input_tokens: 10, output_tokens: 6}
    assert Enum.any?(result.events, &(&1.event == :notification))
    assert Enum.any?(result.events, &(&1.event == :turn_completed))
  end

  describe "validate_profile/1" do
    test "requires a model and runtime-resolved credential" do
      assert AnthropicMessages.validate_profile(%{}) == {:error, {:missing_requirement, :model}}

      assert AnthropicMessages.validate_profile(%{"model" => "claude-sonnet-4-5"}) ==
               {:error, {:missing_requirement, :credential}}

      assert AnthropicMessages.validate_profile(%{
               "model" => "claude-sonnet-4-5",
               "credential_ref" => %{"secret" => "sk-ant-test"}
             }) == :ok
    end
  end

  describe "response_events/1" do
    test "normalizes message content, tool calls, usage, and stop reason" do
      response = %{
        "type" => "message",
        "id" => "msg_123",
        "model" => "claude-sonnet-4-5",
        "content" => [
          %{"type" => "text", "text" => "I will check."},
          %{
            "type" => "tool_use",
            "id" => "toolu_123",
            "name" => "repository_read",
            "input" => %{"path" => "README.md"}
          }
        ],
        "usage" => %{"input_tokens" => 10, "output_tokens" => 6},
        "stop_reason" => "tool_use"
      }

      assert [
               %{type: "run.started", provider: "anthropic", run_id: "msg_123", model: "claude-sonnet-4-5"},
               %{type: "message.delta", text: "I will check."},
               %{type: "message.completed", text: "I will check."},
               %{
                 type: "tool.started",
                 call_id: "toolu_123",
                 tool_name: "repository_read",
                 arguments: %{"path" => "README.md"}
               },
               %{
                 type: "run.completed",
                 usage: %{input_tokens: 10, output_tokens: 6},
                 stop_reason: "tool_calls"
               }
             ] = AnthropicMessages.response_events(response)
    end
  end

  describe "normalize_event/1" do
    test "normalizes streaming text deltas and tool use blocks" do
      assert AnthropicMessages.normalize_event(%{
               "type" => "content_block_start",
               "content_block" => %{"type" => "text", "text" => ""}
             }) == :ignore

      assert AnthropicMessages.normalize_event(%{
               "type" => "content_block_delta",
               "delta" => %{"type" => "text_delta", "text" => "hello"}
             }) == {:ok, %{type: "message.delta", text: "hello"}}

      assert AnthropicMessages.normalize_event(%{
               "type" => "content_block_start",
               "index" => 1,
               "content_block" => %{
                 "type" => "tool_use",
                 "id" => "toolu_1",
                 "name" => "create_plan",
                 "input" => %{"title" => "Plan"}
               }
             }) ==
               {:ok,
                %{
                  type: "tool.started",
                  call_id: "toolu_1",
                  tool_name: "create_plan",
                  arguments: %{"title" => "Plan"},
                  index: 1
                }}
    end

    test "normalizes streaming tool input JSON deltas" do
      assert AnthropicMessages.normalize_event(%{
               "type" => "content_block_delta",
               "index" => 2,
               "delta" => %{"type" => "input_json_delta", "partial_json" => "{\"path\""}
             }) == {:ok, %{type: "tool.arguments.delta", index: 2, partial_json: "{\"path\""}}
    end

    test "normalizes usage deltas and stop reasons" do
      assert AnthropicMessages.normalize_event(%{
               "type" => "message_delta",
               "delta" => %{"stop_reason" => "max_tokens"},
               "usage" => %{"output_tokens" => 20}
             }) ==
               {:ok,
                %{
                  type: "usage.updated",
                  usage: %{output_tokens: 20},
                  stop_reason: "max_tokens"
                }}
    end

    test "maps provider error events into normalized failure categories" do
      assert AnthropicMessages.normalize_event(%{
               "type" => "error",
               "error" => %{"type" => "overloaded_error", "message" => "busy"}
             }) ==
               {:ok,
                %{
                  type: "run.failed",
                  error_code: "provider_capacity",
                  retryable: true,
                  reason: "busy"
                }}
    end
  end

  describe "failure classification" do
    test "maps Anthropic status errors into auth, capacity, unavailable, and retryable categories" do
      response = %Req.Response{
        status: 529,
        headers: [{"request-id", "req_123"}],
        body: %{"error" => %{"type" => "overloaded_error", "message" => "overloaded"}}
      }

      assert %{
               provider: "anthropic",
               model: "claude-sonnet-4-5",
               status: 529,
               provider_request_id: "req_123",
               error_code: "provider_capacity",
               retryable: true,
               reason: "overloaded"
             } =
               AnthropicMessages.classify_status_failure(
                 529,
                 response.body,
                 response,
                 %{provider: "anthropic", model: "claude-sonnet-4-5"},
                 12
               )
    end
  end

  test "advertises Anthropic Messages capabilities" do
    assert AnthropicMessages.supports?(:messages)
    assert AnthropicMessages.supports?(:tool_calls)
    assert AnthropicMessages.supports?(:usage)
    assert AnthropicMessages.supports?(:streaming)
    refute AnthropicMessages.supports?(:agent_sessions)
  end
end
