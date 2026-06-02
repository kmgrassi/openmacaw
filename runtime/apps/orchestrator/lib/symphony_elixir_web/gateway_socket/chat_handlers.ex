defmodule SymphonyElixirWeb.GatewaySocket.ChatHandlers do
  @moduledoc false

  alias SymphonyElixir.ChatGateway
  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixirWeb.Gateway.{Frame, Middleware}
  alias SymphonyElixirWeb.GatewaySocket.Logging

  @spec handle(String.t(), term(), map() | nil, map(), map()) :: {:handled, {[Frame.text_frame()], map()}} | :not_handled
  def handle("chat.send", id, %{} = params, %{scope: scope} = state, _context) do
    run_id = Map.get(params, "idempotencyKey") || Ecto.UUID.generate()

    Logging.log(:info, :request_started, state, %{
      request_id: id,
      frame_method: "chat.send",
      run_id: run_id
    })

    with {:ok, scope} <- Middleware.require_scope(scope, params),
         message = Map.get(params, "message", ""),
         metadata = normalize_metadata(Map.get(params, "metadata")),
         {:ok, run_id} <-
           ChatGateway.post_message(scope, message,
             run_id: run_id,
             owner_pid: self(),
             session_thread_id: state.session_thread_id,
             metadata: metadata,
             workflow_path: state.workflow_path,
             trace_id: state.trace_id,
             connection_id: state.connection_id
           ) do
      Logging.log(:info, :run_started, state, %{run_id: run_id})

      {:handled, {[Frame.response(id, true, %{runId: run_id, ok: true}, nil)], state}}
    else
      {:error, reason} ->
        Logging.log(:warning, :request_failed, state, %{
          request_id: id,
          frame_method: "chat.send",
          run_id: run_id,
          error_code: gateway_error_code(reason),
          retryable: false,
          reason: inspect(reason)
        })

        {:handled, {[Frame.response(id, false, nil, Middleware.normalize_error(reason))], state}}
    end
  end

  def handle("chat.abort", id, %{} = params, %{scope: scope} = state, _context) do
    with {:ok, scope} <- Middleware.require_scope(scope, params),
         {:ok, session} <- SessionStore.abort_run(scope.session_key, Map.get(params, "runId")) do
      payload = %{
        runId: Map.get(params, "runId"),
        sessionKey: (session && session.key) || scope.session_key,
        state: "aborted"
      }

      replies = [
        Frame.response(id, true, %{ok: true}, nil),
        Frame.event("chat", payload)
      ]

      {:handled, {replies, state}}
    else
      {:error, reason} ->
        {:handled, {[Frame.response(id, false, nil, Middleware.normalize_error(reason))], state}}
    end
  end

  def handle(_method, _id, _params, _state, _context), do: :not_handled

  defp gateway_error_code(reason), do: Middleware.normalize_error(reason).code

  defp normalize_metadata(metadata) when is_map(metadata), do: metadata
  defp normalize_metadata(_metadata), do: %{}
end
