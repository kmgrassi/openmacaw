defmodule SymphonyElixir.Runner.OpenClawWS do
  @moduledoc """
  WebSocket runner adapter for OpenClaw gateways.

  The adapter uses the same JSON frame envelope as the runtime gateway where
  possible (`connect`, `chat.send`, `chat.abort`) and normalizes both gateway
  chat events and backend event frames into the runner contract vocabulary.
  """

  @behaviour SymphonyElixir.Runner

  require Logger

  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.Schema.OpenClawFrame

  @default_timeout_ms 300_000
  @default_connect_timeout_ms 5_000
  @default_health_path "/v1/health"

  @capabilities %{
    streaming: true,
    interrupts: true,
    tools: true,
    config_ops: true,
    agent_ops: true,
    session_ops: true
  }

  @impl true
  def start_session(config, _workspace) do
    with :ok <- validate_target(config),
         {:ok, url} <- target_url(config),
         {:ok, pid} <- connect(url, config),
         {:ok, state_agent} <- Agent.start_link(fn -> %{} end),
         session <- build_session(pid, state_agent, url, config),
         :ok <- maybe_connect_gateway(session, config) do
      {:ok, session}
    end
  end

  @impl true
  def run_turn(session, prompt, work_item) do
    run_id = Ecto.UUID.generate()
    session_key = session_key(session, work_item)

    frame = %{
      type: "req",
      id: request_id(),
      method: "chat.send",
      params: %{
        "agent_id" => agent_id(session, work_item),
        "workspace_id" => workspace_id(session, work_item),
        "sessionKey" => session_key,
        "message" => prompt,
        "deliver" => false,
        "idempotencyKey" => run_id,
        "metadata" => work_item_context(work_item)
      }
    }

    put_active_run(session, run_id, session_key)

    case send_json(session.pid, frame) do
      :ok ->
        case wait_for_send_ack(frame.id, session.timeout_ms) do
          :ok ->
            collect_until_terminal(session, run_id, "")

          {:error, _reason} = error ->
            clear_active_run(session, run_id)
            error
        end

      {:error, _reason} = error ->
        clear_active_run(session, run_id)
        error
    end
  end

  @impl true
  def stop_session(%{pid: pid} = session) when is_pid(pid) do
    maybe_abort_active_run(session)
    close_client(pid)
    stop_state_agent(session)
    :ok
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) do
    with {:ok, health_url} <- health_url(config) do
      case Req.get(health_url, headers: auth_headers(config)) do
        {:ok, %Req.Response{status: status}} when status in 200..299 -> :ok
        {:ok, %Req.Response{status: status}} -> {:error, {:unhealthy, status}}
        {:error, reason} -> {:error, reason}
      end
    end
  rescue
    e -> {:error, {:health_check_failed, Exception.message(e)}}
  end

  @impl true
  def requires_workspace?, do: false

  @spec validate_target(map()) :: :ok | {:error, term()}
  def validate_target(config) do
    with {:ok, url} <- target_url(config),
         {:ok, %URI{scheme: scheme, host: host}} when scheme in ["ws", "wss"] and is_binary(host) <- parse_uri(url) do
      :ok
    else
      {:ok, %URI{scheme: scheme}} -> {:error, {:invalid_openclaw_ws_url_scheme, scheme}}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec capabilities() :: map()
  def capabilities, do: @capabilities

  @spec supports?(atom()) :: boolean()
  def supports?(capability), do: Map.get(@capabilities, capability, false)

  defp connect(url, config) do
    WebSockex.start_link(url, __MODULE__.Client, %{owner: self()}, extra_headers: auth_headers(config))
  end

  defp build_session(pid, state_agent, url, config) do
    %{
      pid: pid,
      state_agent: state_agent,
      url: url,
      provider: "openclaw",
      runner: "openclaw_ws",
      model: get_in_string(config, ["routing", "model"]) || Map.get(config, "model"),
      timeout_ms: Map.get(config, "timeout_ms", @default_timeout_ms),
      connect_timeout_ms: Map.get(config, "connect_timeout_ms", @default_connect_timeout_ms),
      agent_id: get_in_string(config, ["routing", "agentId"]) || Map.get(config, "agent_id"),
      workspace_id: Map.get(config, "workspace_id"),
      session_strategy: get_in_string(config, ["routing", "sessionStrategy"]) || Map.get(config, "session_strategy", "create_per_run"),
      on_message: Map.get(config, :on_message) || Map.get(config, "on_message"),
      metadata: %{capabilities: @capabilities}
    }
  end

  defp maybe_connect_gateway(session, config) do
    if Map.get(config, "connect", true) do
      frame = %{
        type: "req",
        id: request_id(),
        method: "connect",
        params: %{
          "agent_id" => session.agent_id,
          "workspace_id" => session.workspace_id,
          "sessionKey" => bootstrap_session_key(session)
        }
      }

      with :ok <- send_json(session.pid, frame) do
        wait_for_connect_ack(frame.id, session.connect_timeout_ms)
      end
    else
      :ok
    end
  end

  defp wait_for_connect_ack(request_id, timeout_ms) do
    receive do
      {:openclaw_ws_frame, %{"type" => "hello-ok"}} ->
        :ok

      {:openclaw_ws_frame, %{"type" => "res", "id" => ^request_id, "ok" => true}} ->
        :ok

      {:openclaw_ws_frame, %{"type" => "res", "id" => ^request_id, "ok" => false} = frame} ->
        {:error, {:connect_rejected, Map.get(frame, "error")}}

      {:openclaw_ws_disconnected, reason} ->
        {:error, {:disconnected, reason}}
    after
      timeout_ms -> {:error, :connect_timeout}
    end
  end

  defp wait_for_send_ack(request_id, timeout_ms) do
    receive do
      {:openclaw_ws_frame, %{"type" => "res", "id" => ^request_id, "ok" => true}} ->
        :ok

      {:openclaw_ws_frame, %{"type" => "res", "id" => ^request_id, "ok" => false} = frame} ->
        {:error, {:fatal, {:run_rejected, Map.get(frame, "error")}}}

      {:openclaw_ws_disconnected, reason} ->
        {:error, {:retryable, {:disconnected, reason}}}
    after
      timeout_ms -> {:error, {:retryable, :send_ack_timeout}}
    end
  end

  defp collect_until_terminal(session, run_id, output) do
    receive do
      {:openclaw_ws_frame, frame} ->
        case normalize_frame(frame) do
          {:event, event, delta} ->
            emit_event(session, event)
            collect_until_terminal(session, run_id, output <> delta)

          {:completed, result} ->
            clear_active_run(session, run_id)
            {:ok, result |> Map.put_new("id", run_id) |> Map.put_new("output_text", output)}

          {:failed, retryable?, reason} ->
            clear_active_run(session, run_id)
            if retryable?, do: {:error, {:retryable, reason}}, else: {:error, {:fatal, reason}}

          :ignore ->
            collect_until_terminal(session, run_id, output)
        end

      {:openclaw_ws_disconnected, reason} ->
        {:error, {:retryable, {:disconnected, reason}}}
    after
      session.timeout_ms -> {:error, {:retryable, :run_timeout}}
    end
  end

  defp normalize_frame(%{"type" => "event", "event" => "chat", "payload" => payload}) when is_map(payload) do
    case OpenClawFrame.validate(%{"type" => "event", "event" => "chat", "payload" => payload}) do
      {:ok, %OpenClawFrame.Chat{} = frame} ->
        normalize_chat_frame(frame)

      {:error, reason} ->
        drop_frame(%{"type" => "event", "event" => "chat", "payload" => payload}, reason)
    end
  end

  defp normalize_frame(%{"type" => type} = frame) when is_binary(type) do
    case OpenClawFrame.validate(frame) do
      {:ok, %OpenClawFrame.BackendEvent{} = event_frame} -> normalize_backend_event(event_frame)
      {:error, reason} -> drop_frame(frame, reason)
    end
  end

  defp normalize_frame(%{"event" => event} = frame) when is_binary(event) do
    case OpenClawFrame.validate(frame) do
      {:ok, %OpenClawFrame.BackendEvent{} = event_frame} -> normalize_backend_event(event_frame)
      {:error, reason} -> drop_frame(frame, reason)
    end
  end

  defp normalize_frame(frame) do
    reason =
      case OpenClawFrame.validate(frame) do
        {:error, reason} -> reason
      end

    drop_frame(frame, reason)
  end

  defp normalize_chat_frame(%OpenClawFrame.Chat{state: state, payload: payload}) do
    case state do
      state when state in [:streaming, :delta] ->
        text = text_from_payload(payload)
        {:event, %{event: :notification, payload: %{"method" => "item/agentMessage/delta", "params" => %{"textDelta" => text}}}, text}

      :final ->
        {:completed, %{"status" => "completed", "output_text" => text_from_payload(payload), "usage" => Map.get(payload, "usage")}}

      :error ->
        {:failed, false, {:run_failed, Map.get(payload, "errorMessage") || Map.get(payload, "error")}}

      :aborted ->
        {:failed, true, :run_cancelled}
    end
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :run_started, raw: frame}) do
    {:event, %{event: :turn_started, payload: frame}, ""}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :message_delta, raw: frame}) do
    text = Map.get(frame, "text", "")
    {:event, %{event: :notification, payload: %{"method" => "message.delta", "params" => %{"textDelta" => text}}}, text}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :message_completed, raw: frame}) do
    text = Map.get(frame, "text", "")
    {:event, %{event: :turn_completed, payload: frame, message: text}, text}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :tool_started, raw: frame}) do
    {:event, %{event: :tool_call_started, payload: frame}, ""}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :tool_completed, raw: frame}) do
    {:event, %{event: :tool_call_completed, payload: frame}, ""}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :warning, raw: frame}) do
    {:event, %{event: :notification, payload: frame, message: Map.get(frame, "message")}, ""}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :error, raw: frame}) do
    {:failed, Map.get(frame, "retryable", false), {:run_failed, Map.get(frame, "message") || frame}}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :run_completed, raw: frame}) do
    {:completed, %{"status" => "completed", "output_text" => Map.get(frame, "output"), "usage" => Map.get(frame, "usage")}}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :run_failed, raw: frame}) do
    {:failed, false, {:run_failed, Map.get(frame, "error") || frame}}
  end

  defp normalize_backend_event(%OpenClawFrame.BackendEvent{event: :run_cancelled}), do: {:failed, true, :run_cancelled}

  defp drop_frame(frame, reason) do
    :telemetry.execute(
      [:symphony_elixir, :runner, :openclaw_ws, :frame, :dropped],
      %{count: 1},
      %{reason: reason, frame_type: frame_type(frame)}
    )

    Logger.warning("openclaw_ws_dropped_frame reason=#{inspect(reason)} frame=#{inspect(frame)}")
    :ignore
  end

  defp frame_type(%{"type" => type}) when is_binary(type), do: type
  defp frame_type(%{"event" => event}) when is_binary(event), do: event
  defp frame_type(_frame), do: nil

  defp emit_event(%{on_message: on_message}, event) when is_function(on_message, 1) do
    case Contract.normalize_event(event) do
      {:ok, normalized} -> on_message.(normalized)
      {:error, reason} -> Logger.warning("openclaw_ws_dropped_event reason=#{inspect(reason)} event=#{inspect(event)}")
    end
  end

  defp emit_event(_session, _event), do: :ok

  defp send_json(pid, frame) do
    WebSockex.send_frame(pid, {:text, Jason.encode!(frame)})
  end

  defp put_active_run(%{state_agent: state_agent}, run_id, session_key) when is_pid(state_agent) do
    Agent.update(state_agent, &Map.put(&1, :active_run, %{run_id: run_id, session_key: session_key}))
  end

  defp put_active_run(_session, _run_id, _session_key), do: :ok

  defp clear_active_run(%{state_agent: state_agent}, run_id) when is_pid(state_agent) do
    Agent.update(state_agent, fn state ->
      case state do
        %{active_run: %{run_id: ^run_id}} -> Map.delete(state, :active_run)
        _ -> state
      end
    end)
  end

  defp clear_active_run(_session, _run_id), do: :ok

  defp maybe_abort_active_run(%{pid: pid, state_agent: state_agent}) when is_pid(pid) and is_pid(state_agent) do
    case Agent.get(state_agent, &Map.get(&1, :active_run)) do
      %{run_id: run_id, session_key: session_key} when is_binary(run_id) ->
        abort_frame = %{
          type: "req",
          id: request_id(),
          method: "chat.abort",
          params: %{
            "runId" => run_id,
            "sessionKey" => session_key
          }
        }

        _ = send_json(pid, abort_frame)
        :ok

      _none ->
        :ok
    end
  end

  defp maybe_abort_active_run(_session), do: :ok

  defp close_client(pid) when is_pid(pid), do: WebSockex.cast(pid, :close)

  defp stop_state_agent(%{state_agent: state_agent}) when is_pid(state_agent), do: Agent.stop(state_agent, :normal)
  defp stop_state_agent(_session), do: :ok

  defp target_url(config) do
    case Map.get(config, "url") || Map.get(config, "ws_url") || Map.get(config, "base_url") do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_config, "url"}}
    end
  end

  defp parse_uri(url), do: {:ok, URI.parse(url)}

  defp health_url(config) do
    explicit = Map.get(config, "health_url")

    if is_binary(explicit) and explicit != "",
      do: {:ok, explicit},
      else: derived_health_url(config)
  end

  defp derived_health_url(config) do
    with {:ok, ws_url} <- target_url(config),
         {:ok, %URI{} = uri} <- parse_uri(ws_url) do
      scheme = if uri.scheme == "wss", do: "https", else: "http"
      {:ok, URI.to_string(%{uri | scheme: scheme, path: @default_health_path, query: nil, fragment: nil})}
    end
  end

  defp auth_headers(config) do
    config_headers = get_in_string(config, ["auth", "headers"]) || %{}
    token = Map.get(config, "api_key") || Map.get(config, "token") || get_in_string(config, ["auth", "token"]) || token_env(config)

    config_headers
    |> Enum.map(fn {key, value} -> {to_string(key), to_string(value)} end)
    |> then(fn headers -> if token, do: [{"authorization", "Bearer #{token}"} | headers], else: headers end)
  end

  defp token_env(config) do
    case get_in_string(config, ["auth", "tokenEnv"]) || get_in_string(config, ["auth", "token_env"]) do
      env when is_binary(env) and env != "" -> System.get_env(env)
      _ -> nil
    end
  end

  defp text_from_payload(payload) do
    get_in(payload, ["message", "content"]) ||
      get_in(payload, ["params", "textDelta"]) ||
      Map.get(payload, "text") ||
      Map.get(payload, "content") ||
      ""
  end

  defp request_id, do: Ecto.UUID.generate()

  defp agent_id(session, work_item), do: session.agent_id || metadata_value(work_item, "agent_id") || work_item.source || "openclaw"
  defp workspace_id(session, work_item), do: session.workspace_id || metadata_value(work_item, "workspace_id") || "default"

  defp session_key(%{session_strategy: "reuse"} = session, work_item) do
    Map.get(session, :session_key) || metadata_value(work_item, "session_key") || "work-item:#{work_item.id}"
  end

  defp session_key(_session, work_item), do: "run:#{work_item.id}:#{System.unique_integer([:positive])}"

  defp bootstrap_session_key(session), do: Map.get(session, :session_key) || "openclaw:bootstrap"

  defp metadata_value(%{metadata: metadata}, key) when is_map(metadata), do: Map.get(metadata, key) || Map.get(metadata, String.to_atom(key))
  defp metadata_value(_work_item, _key), do: nil

  defp work_item_context(work_item) do
    %{
      id: work_item.id,
      identifier: work_item.identifier,
      title: work_item.title,
      description: work_item.description,
      labels: work_item.labels,
      metadata: work_item.metadata
    }
  end

  defp get_in_string(map, keys) when is_map(map) do
    Enum.reduce_while(keys, map, fn key, acc ->
      cond do
        is_map(acc) and Map.has_key?(acc, key) -> {:cont, Map.get(acc, key)}
        is_map(acc) and Map.has_key?(acc, String.to_atom(key)) -> {:cont, Map.get(acc, String.to_atom(key))}
        true -> {:halt, nil}
      end
    end)
  end

  defp get_in_string(_map, _keys), do: nil

  defmodule Client do
    @moduledoc false
    use WebSockex

    @impl true
    def handle_frame({:text, text}, state) do
      case Jason.decode(text) do
        {:ok, frame} -> send(state.owner, {:openclaw_ws_frame, frame})
        {:error, reason} -> send(state.owner, {:openclaw_ws_decode_error, reason, text})
      end

      {:ok, state}
    end

    def handle_frame(_frame, state), do: {:ok, state}

    @impl true
    def handle_cast(:close, state), do: {:close, state}

    @impl true
    def handle_disconnect(connection_status, state) do
      send(state.owner, {:openclaw_ws_disconnected, connection_status})
      {:ok, state}
    end
  end
end
