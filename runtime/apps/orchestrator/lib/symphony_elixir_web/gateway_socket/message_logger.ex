defmodule SymphonyElixirWeb.GatewaySocket.MessageLogger do
  @moduledoc """
  Persists gateway session-thread and message-log records without coupling the socket to the adapter.
  """

  alias SymphonyElixir.MessageLog
  alias SymphonyElixirWeb.GatewaySocket.Logging

  @spec upsert_session_thread(map(), map()) :: String.t() | nil
  def upsert_session_thread(%{scope: scope} = state, agent) when is_map(scope) do
    case message_log().upsert_session_thread(scope,
           label: agent.name || scope.session_key,
           model: model_name(agent)
         ) do
      {:ok, session_thread_id} ->
        session_thread_id

      :disabled ->
        nil

      {:error, reason} ->
        log_persistence_failed(state, "message_log.upsert_session_thread", reason, %{})
        nil
    end
  end

  @spec record(:user | :assistant, map(), map()) :: :ok
  def record(:user, state, attrs) do
    record_user_message(state, attrs)
  end

  def record(:assistant, state, attrs) do
    record_assistant_message(state, attrs)
  end

  defp record_user_message(
         %{scope: scope, session_thread_id: session_thread_id} = state,
         %{message: message, run_id: run_id, metadata: metadata}
       )
       when is_map(scope) and is_binary(session_thread_id) and is_map(metadata) do
    message_opts =
      if map_size(metadata) == 0 do
        [run_id: run_id]
      else
        [run_id: run_id, metadata: metadata]
      end

    case message_log().record_user_message(scope, session_thread_id, message, message_opts) do
      :ok ->
        :ok

      :disabled ->
        :ok

      {:error, reason} ->
        log_persistence_failed(state, "message_log.record_user_message", reason, %{
          session_thread_id: session_thread_id,
          run_id: run_id
        })

        :ok
    end
  end

  defp record_user_message(_state, _attrs), do: :ok

  defp record_assistant_message(
         %{scope: scope, session_thread_id: session_thread_id} = state,
         %{message: message, run_id: run_id, metadata: metadata} = attrs
       )
       when is_map(scope) and is_binary(session_thread_id) and is_map(metadata) do
    case message_log().record_assistant_message(
           scope,
           session_thread_id,
           message,
           run_id,
           metadata,
           tool_calls: Map.get(attrs, :tool_calls, [])
         ) do
      :ok ->
        :ok

      :disabled ->
        :ok

      {:error, reason} ->
        log_persistence_failed(state, "message_log.record_assistant_message", reason, %{
          session_thread_id: session_thread_id,
          run_id: run_id
        })

        :ok
    end
  end

  defp record_assistant_message(_state, _attrs), do: :ok

  defp log_persistence_failed(state, operation, reason, fields) do
    Logging.log(
      :warning,
      :gateway_message_persistence_failed,
      state,
      fields
      |> Map.merge(%{
        operation: operation,
        error_code: "message_persistence_failed",
        non_fatal: true,
        reason: inspect(reason),
        retryable: retryable_persistence_failure?(reason)
      })
    )
  end

  defp retryable_persistence_failure?({:http_error, 429, _body}), do: true
  defp retryable_persistence_failure?({:http_error, status, _body}) when status >= 500, do: true
  defp retryable_persistence_failure?({:request_failed, _reason}), do: true
  defp retryable_persistence_failure?(_reason), do: false

  defp message_log do
    Application.get_env(:symphony_elixir, :message_log_adapter, MessageLog)
  end

  defp model_name(agent) do
    model_settings = Map.get(agent, :model_settings) || Map.get(agent, "model_settings") || %{}
    Map.get(model_settings, "model") || Map.get(model_settings, :model)
  end
end
