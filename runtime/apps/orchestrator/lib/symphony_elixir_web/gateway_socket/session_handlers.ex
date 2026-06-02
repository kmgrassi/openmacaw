defmodule SymphonyElixirWeb.GatewaySocket.SessionHandlers do
  @moduledoc false

  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixirWeb.Gateway.{Frame, Middleware}

  @spec handle(String.t(), term(), map() | nil, map(), map()) :: {:handled, {[Frame.text_frame()], map()}} | :not_handled
  def handle("sessions.list", id, params, state, _context) do
    limit = (params && Map.get(params, "limit")) || 50

    sessions =
      SessionStore.list_sessions(limit: limit)
      |> Enum.map(&session_row/1)

    payload = %{ts: System.system_time(:second), count: length(sessions), sessions: sessions}
    {:handled, {[Frame.response(id, true, payload, nil)], state}}
  end

  def handle("sessions.reset", id, %{"key" => key}, state, _context) do
    case SessionStore.reset_session(key) do
      {:ok, _session} ->
        {:handled, {[Frame.response(id, true, %{ok: true}, nil)], state}}

      {:error, reason} ->
        {:handled, {[Frame.response(id, false, nil, Middleware.normalize_error(reason))], state}}
    end
  end

  def handle("sessions.delete", id, %{"key" => key}, state, _context) do
    :ok = SessionStore.delete_session(key)
    {:handled, {[Frame.response(id, true, %{ok: true}, nil)], state}}
  end

  def handle("sessions.usage", id, _params, state, _context) do
    {:handled, {[Frame.response(id, true, SessionStore.usage_snapshot(), nil)], state}}
  end

  def handle(_method, _id, _params, _state, _context), do: :not_handled

  defp session_row(session) do
    %{
      key: session.key,
      id: session.id,
      agentId: session.agent_id,
      workspaceId: session.workspace_id,
      userId: session.user_id,
      sessionId: session.id,
      kind: session.kind,
      label: session.label,
      displayName: session.display_name,
      surface: session.surface,
      updatedAt: session.updated_at,
      inputTokens: session.input_tokens,
      outputTokens: session.output_tokens,
      totalTokens: session.total_tokens,
      model: session.model
    }
  end
end
