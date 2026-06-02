defmodule SymphonyElixir.LocalRelay.Handlers.RuntimeManaged do
  @moduledoc """
  Session handler for runtime-managed relay turns.

  This shape mirrors the Responses API enough for the manager model client:
  tool-call request frames become `requires_action` responses, terminal frames
  become assistant message responses.
  """

  @behaviour SymphonyElixir.LocalRelay.Session

  alias SymphonyElixir.LocalRelay.{ProtocolExtensions, Session}
  alias SymphonyElixir.ToolAdapter

  @impl true
  def init(context) do
    %{
      correlation_id: Map.fetch!(context, :correlation_id),
      timeout_ms: Map.fetch!(context, :timeout_ms),
      output: ""
    }
  end

  @impl true
  def timeout_ms(state), do: state.timeout_ms

  @impl true
  def handle_frame(:started, _frame, state), do: {:continue, state}

  def handle_frame(:tool_call_request, frame, state), do: {:ok, tool_call_response(state.correlation_id, frame)}

  def handle_frame(:progress, %{"type" => "tool_call_request"} = frame, state), do: {:ok, tool_call_response(state.correlation_id, frame)}
  def handle_frame(:progress, %{"event" => "tool_call_request"} = frame, state), do: {:ok, tool_call_response(state.correlation_id, frame)}

  def handle_frame(:progress, frame, state) do
    {:continue, %{state | output: state.output <> progress_text(frame)}}
  end

  def handle_frame(:complete, frame, state), do: {:ok, completed_response(state.correlation_id, frame, state.output)}

  def handle_frame(:error, frame, _state) do
    {retryable?, reason} = Session.classify_error(frame)
    if retryable?, do: {:error, {:retryable, reason}}, else: {:error, {:fatal, reason}}
  end

  def handle_frame(:tool_call_result, _frame, state), do: {:continue, state}

  defp tool_call_response(correlation_id, frame) do
    %{
      "id" => correlation_id,
      "status" => "requires_action",
      "output" => Enum.map(normalize_tool_calls(frame), &function_call_output/1),
      "usage" => Session.frame_usage(frame) || %{},
      "metadata" => Session.frame_metadata(frame)
    }
  end

  defp completed_response(correlation_id, frame, fallback_output) do
    output_text = Session.complete_output(frame, fallback_output)

    %{
      "id" => correlation_id,
      "status" => "completed",
      "output" => [
        %{
          "type" => "message",
          "role" => "assistant",
          "content" => [%{"type" => "output_text", "text" => output_text}]
        }
      ],
      "usage" => Session.frame_usage(frame) || %{},
      "metadata" => Session.frame_metadata(frame)
    }
  end

  defp normalize_tool_calls(frame) do
    case ProtocolExtensions.normalize_tool_calls(frame) do
      [] -> normalize_openai_tool_calls(map_value(frame, :tool_calls) || [])
      calls -> calls
    end
  end

  defp normalize_openai_tool_calls(calls) when is_list(calls) do
    calls
    |> then(&ToolAdapter.parse_tool_calls(%{"tool_calls" => &1}, :openai_compatible))
    |> Enum.flat_map(fn call ->
      if present?(call.name) do
        [%{"id" => call.id, "name" => call.name, "arguments" => call.arguments, "raw_arguments" => call.raw_arguments, "malformed_arguments?" => call.malformed_arguments?}]
      else
        []
      end
    end)
  end

  defp normalize_openai_tool_calls(_calls), do: []

  defp function_call_output(%{"id" => id, "name" => name, "arguments" => arguments} = call) do
    %{
      "type" => "function_call",
      "call_id" => id,
      "name" => name,
      "arguments" => function_call_arguments(arguments, Map.get(call, "raw_arguments"), Map.get(call, "malformed_arguments?"))
    }
  end

  defp function_call_arguments(_arguments, raw_arguments, true) when is_binary(raw_arguments), do: raw_arguments
  defp function_call_arguments(arguments, _raw_arguments, _malformed?), do: Jason.encode!(arguments || %{})

  defp progress_text(frame) do
    case Map.get(frame, "event") || Map.get(frame, :event) do
      "message.delta" -> Map.get(frame, "text") || get_in(frame, ["payload", "text"]) || ""
      _event -> ""
    end
  end

  defp map_value(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} ->
        value

      :error ->
        string_key = to_string(key)
        Enum.find_value(map, fn {candidate_key, value} -> if to_string(candidate_key) == string_key, do: value end)
    end
  end

  defp map_value(_map, _key), do: nil

  defp present?(value), do: is_binary(value) and String.trim(value) != ""
end
