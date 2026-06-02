defmodule SymphonyElixirWeb.GatewaySocket.RunnerEventTranslation do
  @moduledoc """
  Translates runner process events into gateway chat events.
  """

  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixir.ToolCallPersistence
  alias SymphonyElixirWeb.Gateway.Frame
  alias SymphonyElixirWeb.GatewaySocket.Notifications

  @spec translate(String.t(), String.t(), map(), map()) :: {Frame.text_frame() | nil, map()}
  def translate(
        session_key,
        run_id,
        %{event: :notification, payload: payload},
        state
      ) do
    case Notifications.chat_delta_event(session_key, run_id, %{
           event: :notification,
           payload: payload
         }) do
      {:ok, payload} ->
        delta = payload.message
        :ok = SessionStore.append_delta(run_id, delta)

        {Frame.event("chat", payload), state}

      :ignore ->
        {nil, state}
    end
  end

  def translate(
        session_key,
        run_id,
        %{event: event, payload: payload} = message,
        state
      )
      when event in [:tool_call_started, :tool_call_completed, :tool_call_failed] do
    payload =
      payload
      |> Map.put("runId", run_id)
      |> Map.put("sessionKey", session_key)
      |> Map.put("state", Atom.to_string(event))
      |> Map.put_new("message", Map.get(message, :message))
      |> reject_nil_values()

    {Frame.event("chat", payload), persist_tool_call_event(state, run_id, message)}
  end

  def translate(
        session_key,
        run_id,
        %{"event" => event, "payload" => payload} = message,
        state
      )
      when event in ["tool_call_started", "tool_call_completed", "tool_call_failed"] and
             is_map(payload) do
    payload =
      payload
      |> Map.put("runId", run_id)
      |> Map.put("sessionKey", session_key)
      |> Map.put("state", event)
      |> Map.put_new("message", Map.get(message, "message"))
      |> reject_nil_values()

    {Frame.event("chat", payload), persist_tool_call_event(state, run_id, message)}
  end

  def translate(_session_key, _run_id, _message, state), do: {nil, state}

  defp persist_tool_call_event(state, run_id, message) do
    update_in(state, [:tool_call_acc, run_id], fn acc ->
      ToolCallPersistence.apply_event(acc || ToolCallPersistence.empty(), message)
    end)
  end

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end
end
