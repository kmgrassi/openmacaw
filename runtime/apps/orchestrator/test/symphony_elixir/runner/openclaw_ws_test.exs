defmodule SymphonyElixir.Runner.OpenClawWSTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.OpenClawWS
  alias SymphonyElixir.WorkItem

  describe "start_session/2" do
    test "validates websocket targets and advertises capabilities" do
      assert :ok = OpenClawWS.validate_target(%{"url" => "ws://localhost:4000/gateway"})
      assert {:error, {:invalid_openclaw_ws_url_scheme, "http"}} = OpenClawWS.validate_target(%{"url" => "http://localhost:4000/gateway"})
      assert OpenClawWS.supports?(:streaming)
      assert OpenClawWS.supports?(:interrupts)
      refute OpenClawWS.supports?(:unknown)
      assert OpenClawWS.requires_workspace?() == false
    end

    test "opens a gateway websocket and completes connect handshake" do
      {port, server_ref} =
        start_ws_server(fn
          %{"method" => "connect", "id" => id} ->
            [%{type: "res", id: id, ok: true, payload: %{connected: true}}]
        end)

      assert {:ok, session} = OpenClawWS.start_session(%{"url" => "ws://localhost:#{port}/gateway"}, nil)
      assert session.url == "ws://localhost:#{port}/gateway"
      assert session.metadata.capabilities.streaming == true

      pid = session.pid
      OpenClawWS.stop_session(session)
      assert_process_exits(pid)
      stop_test_server(server_ref)
    end
  end

  describe "run_turn/3" do
    test "sends chat request and returns final gateway output" do
      parent = self()

      {port, server_ref} =
        start_ws_server(fn
          %{"method" => "connect", "id" => id} ->
            [%{type: "res", id: id, ok: true, payload: %{connected: true}}]

          %{"method" => "chat.send", "id" => id, "params" => params} ->
            send(parent, {:chat_send_params, params})

            [
              %{type: "res", id: id, ok: true, payload: %{runId: params["idempotencyKey"]}},
              %{type: "event", event: "chat", payload: %{runId: params["idempotencyKey"], state: "streaming", message: %{role: "assistant", content: "hel"}}},
              %{type: "event", event: "chat", payload: %{runId: params["idempotencyKey"], state: "streaming", message: %{role: "assistant", content: "lo"}}},
              %{
                type: "event",
                event: "chat",
                payload: %{
                  runId: params["idempotencyKey"],
                  state: "final",
                  message: %{role: "assistant", content: "hello"},
                  usage: %{input_tokens: 1}
                }
              }
            ]
        end)

      updates = []
      config = %{"url" => "ws://localhost:#{port}/gateway", "on_message" => fn event -> send(parent, {:runner_event, event}) end}
      {:ok, session} = OpenClawWS.start_session(config, nil)

      assert {:ok, result} = OpenClawWS.run_turn(session, "Fix it", build_work_item())
      assert result["status"] == "completed"
      assert result["output_text"] == "hello"
      assert result["usage"] == %{"input_tokens" => 1}

      assert_receive {:chat_send_params, %{"message" => "Fix it", "metadata" => %{"identifier" => "TEST-1"}}}
      assert_receive {:runner_event, %{event: :notification, payload: %{"params" => %{"textDelta" => "hel"}}}}
      assert_receive {:runner_event, %{event: :notification, payload: %{"params" => %{"textDelta" => "lo"}}}}

      assert updates == []

      pid = session.pid
      OpenClawWS.stop_session(session)
      assert_process_exits(pid)
      stop_test_server(server_ref)
    end

    test "maps backend event frames into normalized runner events" do
      parent = self()

      {port, server_ref} =
        start_ws_server(fn
          %{"method" => "connect", "id" => id} ->
            [%{type: "res", id: id, ok: true}]

          %{"method" => "chat.send", "id" => id} ->
            [
              %{type: "res", id: id, ok: true},
              %{type: "run.started", runId: "run-1"},
              %{type: "message.delta", text: "partial"},
              %{type: "tool.started", name: "shell", callId: "call-1"},
              %{type: "run.completed", output: "done", usage: %{total_tokens: 12}}
            ]
        end)

      config = %{"url" => "ws://localhost:#{port}/gateway", "on_message" => fn event -> send(parent, {:runner_event, event}) end}
      {:ok, session} = OpenClawWS.start_session(config, nil)

      assert {:ok, result} = OpenClawWS.run_turn(session, "Fix it", build_work_item())
      assert result["output_text"] == "done"
      assert result["usage"] == %{"total_tokens" => 12}

      assert_receive {:runner_event, %{event: :turn_started}}
      assert_receive {:runner_event, %{event: :notification, payload: %{"params" => %{"textDelta" => "partial"}}}}
      assert_receive {:runner_event, %{event: :tool_call_started, payload: %{"name" => "shell"}}}

      OpenClawWS.stop_session(session)
      stop_test_server(server_ref)
    end

    test "logs and emits telemetry for malformed frames while waiting for terminal output" do
      parent = self()
      handler_id = "openclaw-ws-dropped-frame-#{System.unique_integer([:positive])}"

      :telemetry.attach(
        handler_id,
        [:symphony_elixir, :runner, :openclaw_ws, :frame, :dropped],
        fn event, measurements, metadata, _config ->
          send(parent, {:telemetry_event, event, measurements, metadata})
        end,
        nil
      )

      on_exit(fn -> :telemetry.detach(handler_id) end)

      {port, server_ref} =
        start_ws_server(fn
          %{"method" => "connect", "id" => id} ->
            [%{type: "res", id: id, ok: true}]

          %{"method" => "chat.send", "id" => id} ->
            [
              %{type: "res", id: id, ok: true},
              %{type: "message.delta", text: 12},
              %{type: "run.completed", output: "done"}
            ]
        end)

      {:ok, session} = OpenClawWS.start_session(%{"url" => "ws://localhost:#{port}/gateway"}, nil)

      log =
        capture_log(fn ->
          assert {:ok, %{"output_text" => "done"}} = OpenClawWS.run_turn(session, "Fix it", build_work_item())
        end)

      assert log =~ "openclaw_ws_dropped_frame"
      assert log =~ ~s({:invalid_field, "text", :expected_string})

      assert_receive {:telemetry_event, [:symphony_elixir, :runner, :openclaw_ws, :frame, :dropped], %{count: 1}, %{reason: {:invalid_field, "text", :expected_string}, frame_type: "message.delta"}}

      OpenClawWS.stop_session(session)
      stop_test_server(server_ref)
    end

    test "treats chat error frames without string text as terminal failures" do
      {port, server_ref} =
        start_ws_server(fn
          %{"method" => "connect", "id" => id} ->
            [%{type: "res", id: id, ok: true}]

          %{"method" => "chat.send", "id" => id} ->
            [
              %{type: "res", id: id, ok: true},
              %{type: "event", event: "chat", payload: %{state: "error"}}
            ]
        end)

      {:ok, session} = OpenClawWS.start_session(%{"url" => "ws://localhost:#{port}/gateway"}, nil)

      assert {:error, {:fatal, {:run_failed, nil}}} = OpenClawWS.run_turn(session, "Fix it", build_work_item())

      OpenClawWS.stop_session(session)
      stop_test_server(server_ref)
    end

    test "persists active run state so stop_session can abort timed-out turns" do
      parent = self()

      {port, server_ref} =
        start_ws_server(fn
          %{"method" => "connect", "id" => id} ->
            [%{type: "res", id: id, ok: true}]

          %{"method" => "chat.send", "id" => id, "params" => params} ->
            send(parent, {:started_run, params["idempotencyKey"], params["sessionKey"]})
            [%{type: "res", id: id, ok: true}]

          %{"method" => "chat.abort", "params" => params} ->
            send(parent, {:abort_params, params})
            []
        end)

      {:ok, session} =
        OpenClawWS.start_session(
          %{
            "url" => "ws://localhost:#{port}/gateway",
            "timeout_ms" => 10
          },
          nil
        )

      assert {:error, {:retryable, :run_timeout}} = OpenClawWS.run_turn(session, "Fix it", build_work_item())
      assert_receive {:started_run, run_id, session_key}

      pid = session.pid
      OpenClawWS.stop_session(session)

      assert_receive {:abort_params, %{"runId" => ^run_id, "sessionKey" => ^session_key}}
      assert_process_exits(pid)

      stop_test_server(server_ref)
    end

    test "maps retryable backend errors" do
      {port, server_ref} =
        start_ws_server(fn
          %{"method" => "connect", "id" => id} ->
            [%{type: "res", id: id, ok: true}]

          %{"method" => "chat.send", "id" => id} ->
            [
              %{type: "res", id: id, ok: true},
              %{type: "error", message: "queue full", retryable: true}
            ]
        end)

      {:ok, session} = OpenClawWS.start_session(%{"url" => "ws://localhost:#{port}/gateway"}, nil)
      assert {:error, {:retryable, {:run_failed, "queue full"}}} = OpenClawWS.run_turn(session, "Fix it", build_work_item())

      OpenClawWS.stop_session(session)
      stop_test_server(server_ref)
    end
  end

  describe "ping/1" do
    test "checks health endpoint derived from websocket url" do
      {port, server_ref} = start_ws_server(fn _frame -> [] end)

      assert :ok = OpenClawWS.ping(%{"url" => "ws://localhost:#{port}/gateway"})

      stop_test_server(server_ref)
    end
  end

  defp build_work_item do
    %WorkItem{
      id: "wi-#{System.unique_integer([:positive])}",
      identifier: "TEST-1",
      title: "Test work item",
      description: "A test work item for runner tests",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{"workspace_id" => "workspace-1", "agent_id" => "agent-1"}
    }
  end

  defp start_ws_server(handler) do
    port = Enum.random(30_000..39_999)

    plug = {SymphonyElixir.Runner.OpenClawWSTest.Plug, handler: handler}

    {:ok, server_ref} =
      Bandit.start_link(
        plug: plug,
        port: port,
        ip: :loopback,
        startup_log: false
      )

    {port, server_ref}
  end

  defp stop_test_server(server_ref) do
    Supervisor.stop(server_ref)
  catch
    :exit, _ -> :ok
  end

  defp assert_process_exits(pid, attempts \\ 20)
  defp assert_process_exits(pid, _attempts) when not is_pid(pid), do: flunk("expected pid")
  defp assert_process_exits(pid, 0), do: flunk("expected #{inspect(pid)} to exit")

  defp assert_process_exits(pid, attempts) do
    if Process.alive?(pid) do
      Process.sleep(10)
      assert_process_exits(pid, attempts - 1)
    else
      assert true
    end
  end
end

defmodule SymphonyElixir.Runner.OpenClawWSTest.Plug do
  @behaviour Plug

  @impl true
  def init(opts), do: opts

  @impl true
  def call(%Plug.Conn{request_path: "/v1/health"} = conn, _opts) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.resp(200, Jason.encode!(%{ok: true}))
  end

  def call(conn, opts) do
    Plug.Conn.upgrade_adapter(conn, :websocket, {SymphonyElixir.Runner.OpenClawWSTest.Socket, opts, []})
  end
end

defmodule SymphonyElixir.Runner.OpenClawWSTest.Socket do
  @behaviour WebSock

  @impl true
  def init(opts), do: {:ok, opts}

  @impl true
  def handle_in({payload, _opts}, state) do
    handler = Keyword.fetch!(state, :handler)
    frame = Jason.decode!(payload)
    replies = handler.(frame)
    {:push, Enum.map(replies, &{:text, Jason.encode!(&1)}), state}
  end

  @impl true
  def handle_info(_message, state), do: {:ok, state}

  @impl true
  def terminate(_reason, _state), do: :ok
end
