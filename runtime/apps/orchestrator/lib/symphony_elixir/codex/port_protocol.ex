defmodule SymphonyElixir.Codex.PortProtocol do
  @moduledoc """
  JSON-RPC 2.0 framing for Codex app-server ports.
  """

  require Logger

  @max_stream_log_bytes 1_000

  @type turn_dispatcher :: (String.t() -> :continue | {:ok, term()} | {:error, term()})

  @spec send_message(port(), map()) :: true | false
  def send_message(port, message) when is_port(port) and is_map(message) do
    Port.command(port, Jason.encode!(message) <> "\n")
  end

  @spec await_response(port(), term(), timeout()) :: {:ok, map()} | {:error, term()}
  def await_response(port, request_id, timeout_ms) when is_port(port) do
    receive_response_line(port, request_id, timeout_ms, "")
  end

  @spec await_turn(port(), timeout(), turn_dispatcher()) :: {:ok, term()} | {:error, term()}
  def await_turn(port, timeout_ms, dispatcher) when is_port(port) and is_function(dispatcher, 1) do
    receive_turn_line(port, timeout_ms, "", dispatcher)
  end

  defp receive_turn_line(port, timeout_ms, pending_line, dispatcher) do
    receive do
      {^port, {:data, {:eol, chunk}}} ->
        complete_line = pending_line <> to_string(chunk)

        case dispatcher.(complete_line) do
          :continue -> receive_turn_line(port, timeout_ms, "", dispatcher)
          {:ok, _result} = ok -> ok
          {:error, _reason} = error -> error
        end

      {^port, {:data, {:noeol, chunk}}} ->
        receive_turn_line(port, timeout_ms, pending_line <> to_string(chunk), dispatcher)

      {^port, {:exit_status, status}} ->
        {:error, {:port_exit, status}}
    after
      timeout_ms ->
        {:error, :turn_timeout}
    end
  end

  defp receive_response_line(port, request_id, timeout_ms, pending_line) do
    receive do
      {^port, {:data, {:eol, chunk}}} ->
        complete_line = pending_line <> to_string(chunk)
        handle_response(port, request_id, complete_line, timeout_ms)

      {^port, {:data, {:noeol, chunk}}} ->
        receive_response_line(port, request_id, timeout_ms, pending_line <> to_string(chunk))

      {^port, {:exit_status, status}} ->
        {:error, {:port_exit, status}}
    after
      timeout_ms ->
        {:error, :response_timeout}
    end
  end

  defp handle_response(port, request_id, data, timeout_ms) do
    payload = to_string(data)

    case Jason.decode(payload) do
      {:ok, %{"id" => ^request_id, "error" => error}} ->
        {:error, {:response_error, error}}

      {:ok, %{"id" => ^request_id, "result" => result}} ->
        {:ok, result}

      {:ok, %{"id" => ^request_id} = response_payload} ->
        {:error, {:response_error, response_payload}}

      {:ok, %{} = other} ->
        Logger.debug("Ignoring message while waiting for response: #{inspect(other)}")
        receive_response_line(port, request_id, timeout_ms, "")

      {:error, _} ->
        log_non_json_stream_line(payload, "response stream")
        receive_response_line(port, request_id, timeout_ms, "")
    end
  end

  @spec log_non_json_stream_line(term(), String.t()) :: :ok
  def log_non_json_stream_line(data, stream_label) do
    text =
      data
      |> to_string()
      |> String.trim()
      |> String.slice(0, @max_stream_log_bytes)

    if text != "" do
      if String.match?(text, ~r/\b(error|warn|warning|failed|fatal|panic|exception)\b/i) do
        Logger.warning("Codex #{stream_label} output: #{text}")
      else
        Logger.debug("Codex #{stream_label} output: #{text}")
      end
    end

    :ok
  end
end
