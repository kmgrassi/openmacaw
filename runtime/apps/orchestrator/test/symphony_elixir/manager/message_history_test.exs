defmodule SymphonyElixir.MessageHistoryTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.MessageHistory

  defmodule StubAdapter do
    def list_agent_messages(agent_id, opts) do
      send(owner(), {:stub_list_agent_messages, agent_id, opts})

      case Process.get({__MODULE__, :next_response}) do
        nil -> {:ok, [], %{}}
        {:ok, rows} -> {:ok, rows, %{}}
        :disabled -> :disabled
        {:error, _} = error -> error
        other -> other
      end
    end

    def resolve_user_display_names(user_ids) do
      send(owner(), {:stub_resolve_user_display_names, user_ids})
      {:ok, Process.get({__MODULE__, :display_names}, %{})}
    end

    def stub_response(response), do: Process.put({__MODULE__, :next_response}, response)
    def stub_display_names(display_names), do: Process.put({__MODULE__, :display_names}, display_names)

    defp owner, do: Application.fetch_env!(:symphony_elixir, :message_history_test_owner)
  end

  setup do
    Application.put_env(:symphony_elixir, :message_history_test_owner, self())
    Application.put_env(:symphony_elixir, :message_log_adapter, StubAdapter)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :message_history_test_owner)
      Application.delete_env(:symphony_elixir, :message_log_adapter)
    end)

    :ok
  end

  defp scope, do: %{agent_id: "agent-1", workspace_id: "ws-1", session_key: "agent:agent-1:main", user_id: "user-1"}

  test "returns [] when scope is nil" do
    assert MessageHistory.fetch(nil, limit: 5) == []
  end

  test "returns [] when agent_id is missing" do
    assert MessageHistory.fetch(%{workspace_id: "ws-1"}, limit: 5) == []
  end

  test "returns [] when limit is 0 or negative" do
    StubAdapter.stub_response({:ok, [row("user", "hi", "r1")]})
    assert MessageHistory.fetch(scope(), limit: 0) == []
    assert MessageHistory.fetch(scope(), limit: -1) == []
    refute_received {:stub_list_agent_messages, _, _}
  end

  test "fetches in newest-first DB order and returns oldest-first messages" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("assistant", "third", "r3"),
         row("user", "second", "r2"),
         row("assistant", "first", "r1")
       ]}
    )

    assert MessageHistory.fetch(scope(), limit: 10) == [
             %{"role" => "assistant", "content" => "first"},
             %{"role" => "user", "content" => "second"},
             %{"role" => "assistant", "content" => "third"}
           ]
  end

  test "prefixes historical user turns with resolved speaker display names" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("user", "what changed?", "r2", speaker_display_name: "Dana"),
         row("user", "ship it", "r1", speaker_display_name: "Kevin")
       ]}
    )

    assert MessageHistory.fetch(scope(), limit: 10) == [
             %{"role" => "user", "content" => "Kevin says:\nship it"},
             %{"role" => "user", "content" => "Dana says:\nwhat changed?"}
           ]
  end

  test "falls back to user_id when a historical user row has no display name" do
    StubAdapter.stub_response({:ok, [row("user", "hello", "r1", user_id: "user-2")]})

    assert MessageHistory.fetch(scope(), limit: 10) == [
             %{"role" => "user", "content" => "user-2 says:\nhello"}
           ]
  end

  test "resolves current speaker labels for the live user turn" do
    StubAdapter.stub_display_names(%{"user-1" => "Kevin"})

    assert MessageHistory.current_speaker_label(scope()) == "Kevin"
    assert_received {:stub_resolve_user_display_names, ["user-1"]}
  end

  test "passes workspace_id and an overfetched limit to the adapter" do
    StubAdapter.stub_response({:ok, []})

    MessageHistory.fetch(scope(), limit: 3)

    assert_received {:stub_list_agent_messages, "agent-1", opts}
    assert Keyword.get(opts, :workspace_id) == "ws-1"
    assert Keyword.get(opts, :include_tool_calls)
    # limit + overfetch (5) to leave room for filtering
    assert Keyword.get(opts, :limit) == 8
  end

  test "passes session thread id when present so model replay stays within a chat thread" do
    StubAdapter.stub_response({:ok, []})

    scope()
    |> Map.put(:session_thread_id, "thread-1")
    |> MessageHistory.fetch(limit: 3)

    assert_received {:stub_list_agent_messages, "agent-1", opts}
    assert Keyword.get(opts, :session_id) == "thread-1"
  end

  test "excludes rows whose run_id matches :exclude_run_id (the in-flight user message)" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("user", "current-turn", "run-now"),
         row("assistant", "previous-assistant", "run-prev"),
         row("user", "previous-user", "run-prev")
       ]}
    )

    assert MessageHistory.fetch(scope(), limit: 10, exclude_run_id: "run-now") == [
             %{"role" => "user", "content" => "previous-user"},
             %{"role" => "assistant", "content" => "previous-assistant"}
           ]
  end

  test "drops tool rows and empty-content rows without complete tool calls" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("assistant", "", "r3"),
         row("tool", "tool output content", "r2"),
         row("assistant", "real reply", "r1")
       ]}
    )

    assert MessageHistory.fetch(scope(), limit: 10) == [
             %{"role" => "assistant", "content" => "real reply"}
           ]
  end

  test "replays complete assistant tool call rows as assistant and tool messages" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("assistant", "", "r1",
           tool_calls: [
             persisted_tool_call(
               call_id: "call-1",
               tool_name: "task.create",
               arguments: %{"title" => "Write tests"},
               output: %{"success" => true, "result" => %{"id" => "task-1"}}
             )
           ]
         ),
         row("user", "create a task", "r1")
       ]}
    )

    assert [
             %{"role" => "user", "content" => "create a task"},
             %{
               "role" => "assistant",
               "content" => "",
               "tool_calls" => [
                 %{
                   "id" => "call-1",
                   "type" => "function",
                   "function" => %{
                     "name" => "task.create",
                     "arguments" => ~s({"title":"Write tests"})
                   }
                 }
               ]
             },
             %{
               "role" => "tool",
               "tool_call_id" => "call-1",
               "content" => tool_content
             }
           ] = MessageHistory.fetch(scope(), limit: 10)

    assert Jason.decode!(tool_content) == %{"success" => true, "result" => %{"id" => "task-1"}}
  end

  test "drops incomplete persisted tool calls and keeps assistant text when present" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("assistant", "I tried the tool.", "r1",
           tool_calls: [
             %{
               "input" =>
                 Jason.encode!(%{
                   "call_id" => "call-1",
                   "tool_name" => "task.create",
                   "input" => %{"arguments" => %{"title" => "Missing output"}}
                 }),
               "output" => nil
             }
           ]
         )
       ]}
    )

    assert MessageHistory.fetch(scope(), limit: 10) == [
             %{"role" => "assistant", "content" => "I tried the tool."}
           ]
  end

  test "truncates oversized tool outputs before replay" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("assistant", "", "r1",
           tool_calls: [
             persisted_tool_call(
               call_id: "call-1",
               tool_name: "shell.exec",
               arguments: %{"command" => "printf"},
               output: String.duplicate("a", 400)
             )
           ]
         )
       ]}
    )

    [_, tool_message] = MessageHistory.fetch(scope(), limit: 10, max_tool_output_bytes: 256)

    assert tool_message["role"] == "tool"
    assert byte_size(tool_message["content"]) <= 256
    assert tool_message["content"] =~ "[tool output truncated for history replay]"
  end

  test "applies history limit after expanding tool call groups without splitting pairs" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("assistant", "", "r2",
           tool_calls: [
             persisted_tool_call(
               call_id: "call-2",
               tool_name: "task.update",
               arguments: %{"id" => "task-1"},
               output: %{"success" => true}
             )
           ]
         ),
         row("user", "older user", "r1")
       ]}
    )

    assert [
             %{
               "role" => "assistant",
               "content" => "",
               "tool_calls" => [
                 %{
                   "id" => "call-2",
                   "type" => "function",
                   "function" => %{"name" => "task.update", "arguments" => ~s({"id":"task-1"})}
                 }
               ]
             },
             %{"role" => "tool", "tool_call_id" => "call-2", "content" => tool_content}
           ] = MessageHistory.fetch(scope(), limit: 2)

    assert Jason.decode!(tool_content) == %{"success" => true}
  end

  test "drops oversized expanded tool groups that cannot fit inside the history limit" do
    StubAdapter.stub_response(
      {:ok,
       [
         row("assistant", "", "r2",
           tool_calls: [
             persisted_tool_call(call_id: "call-1", tool_name: "one", output: "one"),
             persisted_tool_call(call_id: "call-2", tool_name: "two", output: "two")
           ]
         ),
         row("user", "older user", "r1")
       ]}
    )

    assert MessageHistory.fetch(scope(), limit: 2) == [
             %{"role" => "user", "content" => "older user"}
           ]
  end

  test "clamps requested limit to the hard cap" do
    StubAdapter.stub_response({:ok, []})

    MessageHistory.fetch(scope(), limit: 9999)

    assert_received {:stub_list_agent_messages, _, opts}
    # 50 (cap) + overfetch
    assert Keyword.get(opts, :limit) == 55
  end

  test "trims to requested limit after filtering" do
    rows =
      for i <- 1..20 do
        row("user", "msg-#{21 - i}", "run-#{21 - i}")
      end

    StubAdapter.stub_response({:ok, rows})

    result = MessageHistory.fetch(scope(), limit: 3)

    assert length(result) == 3
    assert Enum.map(result, & &1["content"]) == ["msg-18", "msg-19", "msg-20"]
  end

  test "uses the default limit when none provided" do
    StubAdapter.stub_response({:ok, []})

    MessageHistory.fetch(scope())

    assert_received {:stub_list_agent_messages, _, opts}
    assert Keyword.get(opts, :limit) == MessageHistory.default_limit() + 5
  end

  test "returns [] and does not raise on adapter :disabled" do
    StubAdapter.stub_response(:disabled)
    assert MessageHistory.fetch(scope(), limit: 5) == []
  end

  test "returns [] and does not raise on adapter error" do
    StubAdapter.stub_response({:error, :network_down})
    assert MessageHistory.fetch(scope(), limit: 5) == []
  end

  test "returns [] on unexpected adapter response shape" do
    StubAdapter.stub_response({:ok, "not a list", %{}})
    assert MessageHistory.fetch(scope(), limit: 5) == []
  end

  defp row(role, content, run_id, opts \\ []) do
    %{
      "role" => role,
      "content" => content,
      "run_id" => run_id,
      "created_at" => "2026-05-12T00:00:00Z",
      "user_id" => Keyword.get(opts, :user_id),
      "speaker_display_name" => Keyword.get(opts, :speaker_display_name),
      "tool_calls" => Keyword.get(opts, :tool_calls, [])
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp persisted_tool_call(opts) do
    call_id = Keyword.fetch!(opts, :call_id)
    tool_name = Keyword.fetch!(opts, :tool_name)
    arguments = Keyword.get(opts, :arguments, %{})
    output = Keyword.fetch!(opts, :output)

    %{
      "input" =>
        Jason.encode!(%{
          "call_id" => call_id,
          "tool_name" => tool_name,
          "input" => %{
            "id" => call_id,
            "name" => tool_name,
            "arguments" => arguments
          }
        }),
      "output" =>
        Jason.encode!(%{
          "status" => "ok",
          "output" => output
        })
    }
  end
end
