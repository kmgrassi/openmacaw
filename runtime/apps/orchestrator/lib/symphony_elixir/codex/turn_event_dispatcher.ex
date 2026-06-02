defmodule SymphonyElixir.Codex.TurnEventDispatcher do
  @moduledoc """
  Dispatches Codex app-server turn stream events.
  """

  require Logger

  alias SymphonyElixir.Codex.AppServer.Approvals
  alias SymphonyElixir.Codex.PortProtocol

  @type context :: %{
          port: port(),
          on_message: (map() -> any()),
          tool_executor: (String.t() | nil, map() -> map()),
          auto_approve_requests: boolean(),
          metadata_from_message: (port(), map() -> map())
        }

  @spec handle_line(String.t(), context()) :: :continue | {:ok, term()} | {:error, term()}
  def handle_line(data, ctx) when is_binary(data) and is_map(ctx) do
    payload_string = to_string(data)

    case Jason.decode(payload_string) do
      {:ok, %{"method" => "turn/completed"} = payload} ->
        emit_turn_event(ctx, :turn_completed, payload, payload_string, payload)
        {:ok, :turn_completed}

      {:ok, %{"method" => "turn/failed", "params" => params} = payload} ->
        emit_turn_event(ctx, :turn_failed, payload, payload_string, params)
        {:error, {:turn_failed, params}}

      {:ok, %{"method" => "turn/cancelled", "params" => params} = payload} ->
        emit_turn_event(ctx, :turn_cancelled, payload, payload_string, params)
        {:error, {:turn_cancelled, params}}

      {:ok, %{"method" => method} = payload} when is_binary(method) ->
        handle_turn_method(ctx, payload, payload_string, method)

      {:ok, payload} ->
        emit_message(
          ctx,
          :other_message,
          %{
            payload: payload,
            raw: payload_string
          },
          metadata(ctx, payload)
        )

        :continue

      {:error, _reason} ->
        PortProtocol.log_non_json_stream_line(payload_string, "turn stream")

        if protocol_message_candidate?(payload_string) do
          emit_message(
            ctx,
            :malformed,
            %{
              payload: payload_string,
              raw: payload_string
            },
            metadata(ctx, %{raw: payload_string})
          )
        end

        :continue
    end
  end

  defp emit_turn_event(ctx, event, payload, payload_string, payload_details) do
    emit_message(
      ctx,
      event,
      %{
        payload: payload,
        raw: payload_string,
        details: payload_details
      },
      metadata(ctx, payload)
    )
  end

  defp handle_turn_method(ctx, payload, payload_string, method) do
    metadata = metadata(ctx, payload)

    approvals_ctx = %{
      port: ctx.port,
      on_message: ctx.on_message,
      tool_executor: ctx.tool_executor,
      auto_approve_requests: ctx.auto_approve_requests,
      metadata: metadata
    }

    case Approvals.handle(method, payload, payload_string, approvals_ctx) do
      :input_required ->
        emit_message(
          ctx,
          :turn_input_required,
          %{payload: payload, raw: payload_string},
          metadata
        )

        {:error, {:turn_input_required, payload}}

      :approved ->
        :continue

      :approval_required ->
        emit_message(
          ctx,
          :approval_required,
          %{payload: payload, raw: payload_string},
          metadata
        )

        {:error, {:approval_required, payload}}

      :unhandled ->
        handle_unhandled_method(ctx, payload, payload_string, method, metadata)
    end
  end

  defp handle_unhandled_method(ctx, payload, payload_string, method, metadata) do
    if needs_input?(method, payload) do
      emit_message(
        ctx,
        :turn_input_required,
        %{payload: payload, raw: payload_string},
        metadata
      )

      {:error, {:turn_input_required, payload}}
    else
      emit_message(
        ctx,
        :notification,
        %{
          payload: payload,
          raw: payload_string
        },
        metadata
      )

      Logger.debug("Codex notification: #{inspect(method)}")
      :continue
    end
  end

  defp emit_message(%{on_message: on_message}, event, details, metadata) when is_function(on_message, 1) do
    message =
      metadata
      |> Map.merge(details)
      |> Map.put(:event, event)
      |> Map.put(:timestamp, DateTime.utc_now())

    on_message.(message)
  end

  defp metadata(%{metadata_from_message: metadata_from_message, port: port}, payload)
       when is_function(metadata_from_message, 2) do
    metadata_from_message.(port, payload)
  end

  defp protocol_message_candidate?(data) do
    data
    |> to_string()
    |> String.trim_leading()
    |> String.starts_with?("{")
  end

  defp needs_input?(method, payload)
       when is_binary(method) and is_map(payload) do
    String.starts_with?(method, "turn/") && input_required_method?(method, payload)
  end

  defp needs_input?(_method, _payload), do: false

  defp input_required_method?(method, payload) when is_binary(method) do
    method in [
      "turn/input_required",
      "turn/needs_input",
      "turn/need_input",
      "turn/request_input",
      "turn/request_response",
      "turn/provide_input",
      "turn/approval_required"
    ] || request_payload_requires_input?(payload)
  end

  defp request_payload_requires_input?(payload) do
    params = Map.get(payload, "params")
    needs_input_field?(payload) || needs_input_field?(params)
  end

  defp needs_input_field?(payload) when is_map(payload) do
    Map.get(payload, "requiresInput") == true or
      Map.get(payload, "needsInput") == true or
      Map.get(payload, "input_required") == true or
      Map.get(payload, "inputRequired") == true or
      Map.get(payload, "type") == "input_required" or
      Map.get(payload, "type") == "needs_input"
  end

  defp needs_input_field?(_payload), do: false
end
