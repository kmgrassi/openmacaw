defmodule SymphonyElixir.MessageLogTest do
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog

  alias SymphonyElixir.MessageLog

  setup do
    Application.put_env(:symphony_elixir, :message_log_req_options, plug: {Req.Test, MessageLog})

    Application.put_env(:symphony_elixir, :message_log,
      endpoint: "https://test.supabase.co",
      api_key: "test-api-key"
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :message_log_req_options)
      Application.delete_env(:symphony_elixir, :message_log)
    end)

    :ok
  end

  test "enabled?/0 reflects Supabase configuration" do
    assert MessageLog.enabled?()

    Application.delete_env(:symphony_elixir, :message_log)
    refute MessageLog.enabled?()
  end

  test "list_agent_messages reads paginated history by agent without session scoping" do
    Req.Test.stub(MessageLog, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/message"
      assert auth_headers?(conn)

      params = URI.decode_query(conn.query_string)
      assert params["agent_id"] == "eq.agent-1"
      assert params["workspace_id"] == "eq.workspace-1"
      assert params["or"] == "(created_at.lt.2026-04-25T10:00:00Z,and(created_at.eq.2026-04-25T10:00:00Z,id.lt.message-3))"
      assert params["order"] == "created_at.desc,id.desc"
      assert params["limit"] == "2"
      refute Map.has_key?(params, "created_at")
      refute Map.has_key?(params, "session_key")
      refute Map.has_key?(params, "session_id")

      assert params["select"] =~ "model"
      assert params["select"] =~ "provider"
      refute params["select"] =~ "tool_call("

      json(conn, 200, [
        %{
          "id" => "message-2",
          "role" => "assistant",
          "content" => "Second",
          "created_at" => "2026-04-25T09:59:00Z",
          "metadata" => %{"tokens" => 12},
          "model" => "qwen3-coder:30b",
          "provider" => "openai_compatible",
          "agent_id" => "agent-1",
          "workspace_id" => "workspace-1",
          "session_id" => "thread-2",
          "message_type" => "chat"
        },
        %{
          "id" => "message-1",
          "role" => "user",
          "content" => "First",
          "created_at" => "2026-04-25T09:58:00Z",
          "metadata" => nil,
          "model" => nil,
          "provider" => nil,
          "agent_id" => "agent-1",
          "workspace_id" => "workspace-1",
          "session_id" => "thread-1",
          "message_type" => "chat"
        }
      ])
    end)

    assert {:ok, messages, pagination} =
             MessageLog.list_agent_messages("agent-1",
               workspace_id: "workspace-1",
               limit: "2",
               before: "2026-04-25T10:00:00Z",
               before_id: "message-3"
             )

    assert [
             %{
               "id" => "message-2",
               "role" => "assistant",
               "content" => "Second",
               "createdAt" => 1_777_111_140_000,
               "metadata" => %{"tokens" => 12},
               "model" => "qwen3-coder:30b",
               "provider" => "openai_compatible",
               "session_id" => "thread-2"
             },
             %{
               "id" => "message-1",
               "role" => "user",
               "content" => "First",
               "metadata" => %{},
               "session_id" => "thread-1"
             } = user_message
           ] = messages

    refute Map.has_key?(user_message, "model")
    refute Map.has_key?(user_message, "provider")

    assert pagination == %{
             count: 2,
             limit: 2,
             next_before: "2026-04-25T09:58:00Z",
             next_before_id: "message-1"
           }
  end

  test "list_agent_messages can filter by session id for model replay" do
    Req.Test.stub(MessageLog, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/message"

      params = URI.decode_query(conn.query_string)
      assert params["agent_id"] == "eq.agent-1"
      assert params["workspace_id"] == "eq.workspace-1"
      assert params["session_id"] == "eq.thread-1"

      json(conn, 200, [])
    end)

    assert {:ok, [], %{count: 0, limit: 50}} =
             MessageLog.list_agent_messages("agent-1",
               workspace_id: "workspace-1",
               session_id: "thread-1"
             )
  end

  test "list_agent_messages resolves sender display names for user-authored rows" do
    Req.Test.stub(MessageLog, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/message"} ->
          json(conn, 200, [
            %{
              "id" => "message-1",
              "role" => "user",
              "content" => "First",
              "created_at" => "2026-04-25T09:58:00Z",
              "metadata" => %{},
              "user_id" => "00000000-0000-4000-8000-000000000001"
            },
            %{
              "id" => "message-2",
              "role" => "user",
              "content" => "Second",
              "created_at" => "2026-04-25T09:59:00Z",
              "metadata" => %{},
              "user_id" => "00000000-0000-4000-8000-000000000002"
            },
            %{
              "id" => "message-3",
              "role" => "assistant",
              "content" => "Reply",
              "created_at" => "2026-04-25T10:00:00Z",
              "metadata" => %{},
              "user_id" => "00000000-0000-4000-8000-000000000001"
            }
          ])

        {"GET", "/rest/v1/user"} ->
          params = URI.decode_query(conn.query_string)

          assert params["select"] == "id,full_name,first_name,last_name,email"

          assert params["id"] ==
                   "in.(00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002)"

          json(conn, 200, [
            %{
              "id" => "00000000-0000-4000-8000-000000000001",
              "full_name" => "Kevin Grassi",
              "first_name" => "Kevin",
              "last_name" => "Ignored"
            },
            %{
              "id" => "00000000-0000-4000-8000-000000000002",
              "full_name" => nil,
              "first_name" => "Dana",
              "last_name" => "Scully"
            }
          ])
      end
    end)

    assert {:ok, [first, second, assistant], _pagination} =
             MessageLog.list_agent_messages("agent-1")

    assert first["speaker_display_name"] == "Kevin Grassi"
    assert second["speaker_display_name"] == "Dana Scully"
    refute Map.has_key?(assistant, "speaker_display_name")
  end

  test "list_agent_messages can include related tool_call rows" do
    Req.Test.stub(MessageLog, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/message"

      params = URI.decode_query(conn.query_string)
      assert params["select"] =~ "tool_call(id,message_id,tool_id,input,output)"

      json(conn, 200, [
        %{
          "id" => "message-1",
          "role" => "assistant",
          "content" => "",
          "created_at" => "2026-04-25T09:58:00Z",
          "metadata" => %{},
          "tool_call" => [
            %{
              "id" => "tool-call-row-1",
              "message_id" => "message-1",
              "tool_id" => nil,
              "input" => ~s({"call_id":"call-1"}),
              "output" => ~s({"status":"ok"})
            }
          ]
        }
      ])
    end)

    assert {:ok, [message], _pagination} =
             MessageLog.list_agent_messages("agent-1", include_tool_calls: true)

    assert [
             %{
               "id" => "tool-call-row-1",
               "message_id" => "message-1",
               "input" => ~s({"call_id":"call-1"})
             }
           ] = message["tool_calls"]
  end

  test "resolve_user_display_names falls back to email and skips missing users" do
    Req.Test.stub(MessageLog, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/user"

      params = URI.decode_query(conn.query_string)
      assert params["id"] == "in.(user-1,user-2)"

      json(conn, 200, [
        %{"id" => "user-1", "full_name" => nil, "first_name" => nil, "last_name" => nil, "email" => "dana@example.com"},
        %{"id" => "user-2", "full_name" => "  ", "first_name" => "", "last_name" => nil, "email" => nil}
      ])
    end)

    assert {:ok, %{"user-1" => "dana@example.com"}} =
             MessageLog.resolve_user_display_names(["user-1", "user-2", "user-1", nil, ""])
  end

  test "upsert_session_thread creates the scoped session thread when missing" do
    parent = self()

    Req.Test.stub(MessageLog, fn conn ->
      assert auth_headers?(conn)

      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/session_thread"} ->
          params = URI.decode_query(conn.query_string)
          assert params["agent_id"] == "eq.agent-1"
          assert params["workspace_id"] == "eq.workspace-1"
          assert params["session_key"] == "eq.workspace-1:agent-1"
          json(conn, 200, [])

        {"POST", "/rest/v1/session_thread"} ->
          params = URI.decode_query(conn.query_string)
          assert params["select"] == "id"
          body = json_body(conn)
          send(parent, {:session_thread_payload, body})
          json(conn, 201, [%{"id" => "thread-1"}])

        {"PATCH", "/rest/v1/session_thread"} ->
          assert URI.decode_query(conn.query_string)["id"] == "eq.thread-1"
          body = json_body(conn)
          send(parent, {:session_thread_patch, body})
          Plug.Conn.send_resp(conn, 204, "")
      end
    end)

    assert {:ok, "thread-1"} =
             MessageLog.upsert_session_thread(scope(), label: "Builder", model: "gpt-5.3-codex")

    assert_received {:session_thread_payload, payload}
    assert payload["agent_id"] == "agent-1"
    assert payload["workspace_id"] == "workspace-1"
    assert payload["user_id"] == nil
    assert payload["session_key"] == "workspace-1:agent-1"
    assert payload["status"] == "active"
    assert_received {:session_thread_patch, patch}
    assert patch["label"] == "Builder"
    assert patch["model"] == "gpt-5.3-codex"
  end

  test "upsert_session_thread reuses and patches an existing session thread" do
    parent = self()

    Req.Test.stub(MessageLog, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/session_thread"} ->
          json(conn, 200, [%{"id" => "thread-1"}])

        {"PATCH", "/rest/v1/session_thread"} ->
          assert URI.decode_query(conn.query_string)["id"] == "eq.thread-1"
          body = json_body(conn)
          send(parent, {:session_thread_patch, body})
          Plug.Conn.send_resp(conn, 204, "")
      end
    end)

    assert {:ok, "thread-1"} = MessageLog.upsert_session_thread(scope(), label: "Builder")

    assert_received {:session_thread_patch, payload}
    refute Map.has_key?(payload, "user_id")
    assert payload["label"] == "Builder"
    assert is_binary(payload["updated_at"])
  end

  test "record_user_message writes a message row scoped by agent, workspace, user, and run" do
    parent = self()

    Req.Test.stub(MessageLog, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/message"
      body = json_body(conn)
      send(parent, {:message_payload, body})
      Plug.Conn.send_resp(conn, 201, "")
    end)

    log =
      capture_log([level: :debug], fn ->
        assert :ok = MessageLog.record_user_message(scope(), "thread-1", "Ping", run_id: "run-1")
      end)

    assert_received {:message_payload, payload}
    assert payload["session_id"] == "thread-1"
    assert payload["workspace_id"] == "workspace-1"
    assert payload["agent_id"] == "agent-1"
    assert payload["user_id"] == "user-1"
    assert payload["run_id"] == "run-1"
    assert payload["role"] == "user"
    assert payload["content"] == "Ping"
    refute Map.has_key?(payload, "thread_id")
    assert log =~ ~s("caller":"message_log.record_user_message")
    assert log =~ ~s("workspace_id":"workspace-1")
    assert log =~ ~s("agent_id":"agent-1")
    assert log =~ ~s("session_thread_id":"thread-1")
    assert log =~ ~s("run_id":"run-1")
  end

  test "record_assistant_message writes final content and metadata" do
    parent = self()

    Req.Test.stub(MessageLog, fn conn ->
      body = json_body(conn)
      send(parent, {:message_payload, body})
      Plug.Conn.send_resp(conn, 201, "")
    end)

    assert :ok =
             MessageLog.record_assistant_message(scope(), "thread-1", "Done", "run-1", %{
               input_tokens: 12,
               output_tokens: 4
             })

    assert_received {:message_payload, payload}
    assert payload["role"] == "assistant"
    assert payload["content"] == "Done"
    assert payload["metadata"] == %{"input_tokens" => 12, "output_tokens" => 4}
  end

  test "record_assistant_message writes tool call rows linked to returned message id" do
    parent = self()

    Req.Test.stub(MessageLog, fn conn ->
      case {conn.method, conn.request_path} do
        {"POST", "/rest/v1/message"} ->
          assert Plug.Conn.get_req_header(conn, "prefer") == ["return=representation"]
          assert URI.decode_query(conn.query_string)["select"] == "id"
          body = json_body(conn)
          send(parent, {:message_payload, body})
          json(conn, 201, [%{"id" => "message-1"}])

        {"POST", "/rest/v1/tool_call"} ->
          assert Plug.Conn.get_req_header(conn, "prefer") == ["return=minimal"]
          body = json_body(conn)
          send(parent, {:tool_call_payload, body})
          Plug.Conn.send_resp(conn, 201, "")
      end
    end)

    tool_call = %{
      "call_id" => "call-1",
      "tool_name" => "task.create",
      "status" => "ok",
      "input" => %{"id" => "call-1", "name" => "task.create", "arguments" => %{"title" => "Verify"}},
      "output" => %{"success" => true, "result" => %{"id" => "task-1"}},
      "tool_id" => nil
    }

    assert :ok =
             MessageLog.record_assistant_message(scope(), "thread-1", "Done", "run-1", %{},
               tool_calls: [
                 tool_call
               ]
             )

    assert_received {:message_payload, message_payload}
    assert message_payload["role"] == "assistant"

    assert_received {:tool_call_payload, [row]}
    assert row["message_id"] == "message-1"
    refute Map.has_key?(row, "tool_id")

    assert Jason.decode!(row["input"]) == %{
             "call_id" => "call-1",
             "tool_name" => "task.create",
             "input" => %{"id" => "call-1", "name" => "task.create", "arguments" => %{"title" => "Verify"}}
           }

    assert Jason.decode!(row["output"]) == %{
             "status" => "ok",
             "output" => %{"success" => true, "result" => %{"id" => "task-1"}}
           }
  end

  test "record_assistant_message also writes agent tool call event rows for uuid runs" do
    parent = self()
    run_id = "11111111-1111-4111-8111-111111111111"

    Req.Test.stub(MessageLog, fn conn ->
      case {conn.method, conn.request_path} do
        {"POST", "/rest/v1/message"} ->
          json(conn, 201, [%{"id" => "message-1"}])

        {"POST", "/rest/v1/tool_call"} ->
          Plug.Conn.send_resp(conn, 201, "")

        {"POST", "/rest/v1/agent_tool_call_event"} ->
          assert Plug.Conn.get_req_header(conn, "prefer") == ["return=minimal"]
          body = json_body(conn)
          send(parent, {:agent_tool_call_event_payload, body})
          Plug.Conn.send_resp(conn, 201, "")
      end
    end)

    assert :ok =
             MessageLog.record_assistant_message(uuid_scope(), "thread-1", "Done", run_id, %{},
               tool_calls: [
                 %{
                   "call_id" => "call-1",
                   "tool_name" => "task.create",
                   "status" => "ok",
                   "input" => %{"arguments" => %{"title" => "Verify"}},
                   "output" => %{"success" => true, "result" => %{"id" => "task-1"}}
                 }
               ]
             )

    assert_received {:agent_tool_call_event_payload, [row]}
    assert row["workspace_id"] == "22222222-2222-4222-8222-222222222222"
    assert row["agent_id"] == "33333333-3333-4333-8333-333333333333"
    assert row["run_id"] == run_id
    assert row["correlation_id"] == "call-1"
    assert row["event_type"] == "tool_call_completed"
    assert row["message_kind"] == "assistant_tool_call"
    assert row["tool_slug"] == "task.create"
    assert row["status"] == "ok"
    assert row["arguments"] == %{"title" => "Verify"}
    assert row["result"] == %{"success" => true, "result" => %{"id" => "task-1"}}
    assert row["output_summary"] == ~s({"id":"task-1"})
  end

  test "record_assistant_message preserves explicit non-retryable tool failures" do
    parent = self()

    Req.Test.stub(MessageLog, fn conn ->
      case {conn.method, conn.request_path} do
        {"POST", "/rest/v1/message"} ->
          json(conn, 201, [%{"id" => "message-1"}])

        {"POST", "/rest/v1/tool_call"} ->
          body = json_body(conn)
          send(parent, {:tool_call_payload, body})
          Plug.Conn.send_resp(conn, 201, "")
      end
    end)

    assert :ok =
             MessageLog.record_assistant_message(scope(), "thread-1", "Failed", "run-1", %{},
               tool_calls: [
                 %{
                   "call_id" => "call-1",
                   "tool_name" => "task.create",
                   "status" => "error",
                   "error_code" => "invalid_arguments",
                   "retryable" => false
                 }
               ]
             )

    assert_received {:tool_call_payload, [row]}

    assert Jason.decode!(row["output"]) == %{
             "status" => "error",
             "error_code" => "invalid_arguments",
             "retryable" => false
           }
  end

  test "record_assistant_message keeps chat turn successful when tool call insert fails" do
    Req.Test.stub(MessageLog, fn conn ->
      case {conn.method, conn.request_path} do
        {"POST", "/rest/v1/message"} ->
          json(conn, 201, [%{"id" => "message-1"}])

        {"POST", "/rest/v1/tool_call"} ->
          json(conn, 503, %{"message" => "temporarily unavailable"})
      end
    end)

    log =
      capture_log(fn ->
        assert :ok =
                 MessageLog.record_assistant_message(scope(), "thread-1", "Done", "run-1", %{},
                   tool_calls: [
                     %{"call_id" => "call-1", "tool_name" => "task.create", "status" => "error"}
                   ]
                 )
      end)

    assert log =~ ~s("event":"gateway_message_persistence_failed")
    assert log =~ ~s("operation":"message_log.record_tool_calls")
    assert log =~ ~s("non_fatal":true)
    assert log =~ ~s("retryable":true)
  end

  defp scope do
    %{
      agent_id: "agent-1",
      workspace_id: "workspace-1",
      user_id: "user-1",
      session_key: "workspace-1:agent-1"
    }
  end

  defp uuid_scope do
    %{
      agent_id: "33333333-3333-4333-8333-333333333333",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      user_id: "44444444-4444-4444-8444-444444444444",
      session_key: "22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333"
    }
  end

  defp json_body(conn) do
    {:ok, body, _conn} = Plug.Conn.read_body(conn)
    Jason.decode!(body)
  end

  defp json(conn, status, body) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(status, Jason.encode!(body))
  end

  defp auth_headers?(conn) do
    Plug.Conn.get_req_header(conn, "apikey") == ["test-api-key"] and
      Plug.Conn.get_req_header(conn, "authorization") == ["Bearer test-api-key"]
  end
end
