defmodule SymphonyElixir.Runner.LlmToolRunner.HistoryTest do
  use SymphonyElixir.Runner.ManagerTestSupport

  describe "history splice (v1)" do
    test "splices prior user/assistant text from MessageLog into chat-completions messages array" do
      configure_history_adapter([
        %{"role" => "assistant", "content" => "the number is 7", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:01Z"},
        %{"role" => "user", "content" => "remember the number 7", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:00Z"}
      ])

      test_pid = self()

      Req.Test.stub(__MODULE__, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(test_pid, {:chat_request, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(
          200,
          Jason.encode!(%{
            "id" => "chatcmpl-history-1",
            "choices" => [
              %{
                "finish_reason" => "stop",
                "message" => %{"role" => "assistant", "content" => "still 7"}
              }
            ]
          })
        )
      end)

      {:ok, session} =
        Manager.start_session(
          %{
            "provider" => "openai_compatible",
            "api_key" => "ignored",
            "credential_id" => "cred-local",
            "agent_id" => "agent-history-1",
            "workspace_id" => "workspace-history-1",
            "model" => "qwen3-coder:30b",
            "history_window" => 10,
            :message_recorder_scope => %{
              agent_id: "agent-history-1",
              workspace_id: "workspace-history-1",
              session_key: "agent:agent-history-1:main",
              user_id: "user-1"
            }
          },
          nil
        )

      assert session.history_window == 10

      work_item = %WorkItem{
        id: "chat-session-1",
        identifier: "agent-history-1",
        title: "Manager Chat",
        source: "gateway",
        metadata: %{"run_id" => "run-current"}
      }

      assert {:ok, _} = Manager.run_turn(session, "what number did I tell you?", work_item)

      assert_received {:chat_request, request}

      assert [
               %{"role" => "system"},
               %{"role" => "user", "content" => "remember the number 7"},
               %{"role" => "assistant", "content" => "the number is 7"},
               %{"role" => "user", "content" => "what number did I tell you?"}
             ] = request["messages"]

      Manager.stop_session(session)
    end

    test "drops the in-flight user row from history via exclude_run_id" do
      configure_history_adapter([
        %{"role" => "user", "content" => "in-flight (should be dropped)", "run_id" => "run-current", "created_at" => "2026-05-12T10:01:00Z"},
        %{"role" => "assistant", "content" => "earlier reply", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:01Z"},
        %{"role" => "user", "content" => "earlier prompt", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:00Z"}
      ])

      test_pid = self()

      Req.Test.stub(__MODULE__, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(test_pid, {:chat_request, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(
          200,
          Jason.encode!(%{
            "id" => "chatcmpl-history-2",
            "choices" => [%{"finish_reason" => "stop", "message" => %{"role" => "assistant", "content" => "ok"}}]
          })
        )
      end)

      {:ok, session} =
        Manager.start_session(
          %{
            "provider" => "openai_compatible",
            "api_key" => "ignored",
            "credential_id" => "cred-local",
            "agent_id" => "agent-history-2",
            "workspace_id" => "workspace-history-1",
            "model" => "qwen3-coder:30b",
            :message_recorder_scope => %{
              agent_id: "agent-history-2",
              workspace_id: "workspace-history-1",
              session_key: "agent:agent-history-2:main",
              user_id: "user-1"
            }
          },
          nil
        )

      work_item = %WorkItem{
        id: "chat-session-2",
        identifier: "agent-history-2",
        title: "Manager Chat",
        source: "gateway",
        metadata: %{"run_id" => "run-current"}
      }

      assert {:ok, _} = Manager.run_turn(session, "the new prompt", work_item)

      assert_received {:chat_request, request}

      assert [
               %{"role" => "system"},
               %{"role" => "user", "content" => "earlier prompt"},
               %{"role" => "assistant", "content" => "earlier reply"},
               %{"role" => "user", "content" => "the new prompt"}
             ] = request["messages"]

      Manager.stop_session(session)
    end

    test "prefixes the live user turn before dispatching to the default Responses client" do
      configure_history_adapter([], %{"user-1" => "Kevin"})
      test_pid = self()

      Req.Test.stub(__MODULE__, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(test_pid, {:responses_request, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(
          200,
          Jason.encode!(%{
            "id" => "resp-live-speaker",
            "status" => "completed",
            "output" => [
              %{
                "type" => "message",
                "role" => "assistant",
                "content" => [%{"type" => "output_text", "text" => "ok"}]
              }
            ]
          })
        )
      end)

      {:ok, session} =
        Manager.start_session(
          %{
            "api_key" => "test-key",
            "credential_id" => "cred-openai",
            "agent_id" => "agent-history-responses",
            "workspace_id" => "workspace-history-1",
            "model" => "gpt-test",
            :message_recorder_scope => %{
              agent_id: "agent-history-responses",
              workspace_id: "workspace-history-1",
              session_key: "agent:agent-history-responses:main",
              user_id: "user-1"
            }
          },
          nil
        )

      work_item = %WorkItem{
        id: "chat-session-responses",
        identifier: "agent-history-responses",
        title: "Manager Chat",
        source: "gateway",
        metadata: %{"run_id" => "run-current"}
      }

      assert {:ok, _} = Manager.run_turn(session, "what number did I tell you?", work_item)

      assert_received {:responses_request, request}
      [%{"content" => [%{"type" => "input_text", "text" => text}]}] = request["input"]
      assert text == "Kevin says:\nwhat number did I tell you?"

      Manager.stop_session(session)
    end

    test "history_window zero disables persisted chat history" do
      configure_history_adapter([
        %{"role" => "user", "content" => "old prompt", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:00Z"},
        %{"role" => "assistant", "content" => "old reply", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:01Z"}
      ])

      test_pid = self()

      Req.Test.stub(__MODULE__, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(test_pid, {:chat_request, Jason.decode!(body)})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(
          200,
          Jason.encode!(%{
            "id" => "chatcmpl-history-zero",
            "choices" => [%{"finish_reason" => "stop", "message" => %{"role" => "assistant", "content" => "ok"}}]
          })
        )
      end)

      {:ok, session} =
        Manager.start_session(
          %{
            "provider" => "openai_compatible",
            "api_key" => "ignored",
            "credential_id" => "cred-local",
            "agent_id" => "agent-history-zero",
            "workspace_id" => "workspace-history-1",
            "model" => "qwen3-coder:30b",
            "history_window" => 0,
            :message_recorder_scope => %{
              agent_id: "agent-history-zero",
              workspace_id: "workspace-history-1",
              session_key: "agent:agent-history-zero:scheduled",
              user_id: "user-1"
            }
          },
          nil
        )

      assert session.history_window == 0

      work_item = %WorkItem{
        id: "chat-session-zero",
        identifier: "agent-history-zero",
        title: "Manager Chat",
        source: "gateway",
        metadata: %{"run_id" => "run-current"}
      }

      assert {:ok, _} = Manager.run_turn(session, "fresh scheduled prompt", work_item)

      assert_received {:chat_request, request}

      assert [
               %{"role" => "system"},
               %{"role" => "user", "content" => "fresh scheduled prompt"}
             ] = request["messages"]

      Manager.stop_session(session)
    end
  end
end
