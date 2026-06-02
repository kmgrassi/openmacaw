defmodule SymphonyElixir.Runner.ToolCallingLoop do
  @moduledoc """
  Cloud-managed relay tool-calling orchestration.

  The loop owns one relay correlation and alternates between helper model turns,
  helper tool execution requests, and model continuations until a terminal model
  response is produced or a safety limit is reached.
  """

  require Logger

  alias SymphonyElixir.LocalRelay.{Registry, Session}
  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.Runner.ToolCallingLoop.{DirectProviderLoop, ToolCallNormalization, ToolExecutionDispatcher}
  alias SymphonyElixir.ToolCall

  @default_config %{
    max_iterations: 10,
    timeout_per_tool_ms: 30_000,
    total_timeout_ms: 300_000
  }

  @type config :: %{
          optional(:max_iterations) => pos_integer(),
          optional(:timeout_per_tool_ms) => pos_integer(),
          optional(:total_timeout_ms) => pos_integer()
        }

  @type loop_state :: %{
          iteration: non_neg_integer(),
          tool_calls: [map()],
          messages: [map()],
          started_at: integer(),
          output: String.t(),
          usage: map(),
          metadata: map(),
          repeated_calls: map()
        }

  @doc "Run the tool-calling loop. Returns when the model gives a final response or limits hit."
  @spec run(session :: map(), config()) :: {:ok, map()} | {:error, term()}
  def run(session, config) when is_map(session) and is_map(config) do
    config = normalize_config(config)
    correlation_id = Map.fetch!(session, :correlation_id)
    frame = Map.fetch!(session, :dispatch_frame)

    state = %{
      iteration: 0,
      tool_calls: [],
      messages: initial_messages(session),
      started_at: monotonic_ms(),
      output: "",
      usage: %{},
      metadata: %{},
      repeated_calls: %{}
    }

    with :ok <- dispatch_turn(session, frame, correlation_id) do
      collect(session, config, state)
    end
  end

  @doc """
  Run a runtime-managed direct provider tool-calling loop.

  The session supplies the provider module/profile and tool executor; this
  module owns iteration limits, repeated-call detection, tool validation, result
  message construction, and normalized runner events.
  """
  @spec run_direct(session :: map(), config()) :: {:ok, map()} | {:error, term()}
  def run_direct(session, config) when is_map(session) and is_map(config) do
    DirectProviderLoop.run_direct(session, config)
  end

  @doc "Process a single tool-call response from the model."
  @spec handle_tool_calls(loop_state(), [map()], session :: map()) :: {:continue, loop_state()} | {:error, term()}
  def handle_tool_calls(state, tool_calls, session) when is_list(tool_calls) and is_map(session) do
    if length(tool_calls) == 0 do
      {:continue, state}
    else
      normalized_calls =
        tool_calls
        |> Enum.with_index()
        |> Enum.map(fn {call, index} -> ToolCallNormalization.normalize_tool_call(call, index, session) end)

      {:continue,
       %{
         state
         | iteration: state.iteration + 1,
           tool_calls: state.tool_calls ++ normalized_calls,
           messages: state.messages ++ assistant_tool_call_messages(normalized_calls),
           repeated_calls: repeated_call_counts(state.repeated_calls, normalized_calls)
       }}
    end
  end

  defp collect(session, config, state) do
    correlation_id = Map.fetch!(session, :correlation_id)
    remaining_ms = remaining_total_timeout_ms(config, state)

    if remaining_ms <= 0 do
      Registry.cancel(correlation_id)
      {:error, {:retryable, :local_runner_timeout}}
    else
      case Session.await_frame(correlation_id, remaining_ms) do
        {:ok, :tool_call_request, frame} ->
          tool_calls = ToolCallNormalization.parse_frame_tool_calls(frame, session)
          execute_tool_calls(session, config, state, tool_calls)

        {:ok, :progress, frame} ->
          handle_progress(session, config, state, frame)

        {:ok, :complete, frame} ->
          handle_complete(session, config, state, frame)

        {:ok, :error, frame} ->
          {retryable?, reason} = classify_error(frame)
          emit_event(session, %{event: :turn_ended_with_error, payload: frame, message: to_string(reason)})
          if retryable?, do: {:error, {:retryable, reason}}, else: {:error, {:fatal, reason}}

        {:ok, :tool_call_result, _frame} ->
          collect(session, config, state)

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp handle_progress(session, config, state, %{"type" => "tool_call_request"} = frame) do
    tool_calls = ToolCallNormalization.parse_frame_tool_calls(frame, session)
    execute_tool_calls(session, config, state, tool_calls)
  end

  defp handle_progress(session, config, state, %{"event" => "tool_call_request"} = frame) do
    tool_calls = ToolCallNormalization.parse_frame_tool_calls(frame, session)
    execute_tool_calls(session, config, state, tool_calls)
  end

  defp handle_progress(session, config, state, frame) do
    case normalize_progress(frame) do
      {:event, event, delta} ->
        emit_event(session, event)
        collect(session, config, %{state | output: state.output <> delta})

      {:failed, retryable?, reason} ->
        if retryable?, do: {:error, {:retryable, reason}}, else: {:error, {:fatal, reason}}

      :ignore ->
        collect(session, config, state)
    end
  end

  defp handle_complete(session, config, state, frame) do
    output = complete_output(frame, state.output)

    case ToolCallNormalization.prompt_based_tool_calls(output, session) do
      [] ->
        emit_event(session, %{event: :turn_completed, payload: frame, message: output})

        {:ok,
         %{
           "status" => "completed",
           "correlation_id" => Map.fetch!(session, :correlation_id),
           "output_text" => output,
           "usage" => Map.get(frame, "usage") || Map.get(frame, :usage) || state.usage,
           "metadata" => Map.get(frame, "metadata") || Map.get(frame, :metadata) || state.metadata
         }}

      tool_calls ->
        execute_tool_calls(session, config, state, tool_calls)
    end
  end

  defp execute_tool_calls(session, config, state, tool_calls) do
    cond do
      state.iteration >= config.max_iterations ->
        {:error, {:fatal, {:max_tool_call_iterations_exceeded, config.max_iterations}}}

      true ->
        with {:continue, state} <- handle_tool_calls(state, tool_calls, session),
             :ok <- ensure_no_repeated_calls(state),
             {:ok, state} <- ToolExecutionDispatcher.dispatch_cloud(session, config, state, tool_calls),
             :ok <- dispatch_continuation(session, state) do
          collect(session, config, %{state | output: ""})
        end
    end
  end

  defp dispatch_turn(session, frame, correlation_id) do
    case Session.dispatch(%{workspace_id: session.workspace_id, target_runner_kind: session.target_runner_kind, frame: frame, correlation_id: correlation_id}) do
      {:ok, helper} ->
        emit_event(session, %{event: :turn_started, payload: %{"correlation_id" => correlation_id, "helper" => helper}})
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp dispatch_continuation(session, state) do
    case Session.send_frame(Map.fetch!(session, :correlation_id), continuation_frame(session, state)) do
      :ok -> :ok
      {:error, _reason} -> :ok
    end
  end

  defp continuation_frame(session, state) do
    session.dispatch_frame
    |> Map.put("type", "dispatch")
    |> Map.put("messages", state.messages)
    |> Map.put("tool_call_iteration", state.iteration)
  end

  defp ensure_no_repeated_calls(%{repeated_calls: repeated_calls}) do
    case Enum.find(repeated_calls, fn {_key, count} -> count >= 3 end) do
      nil -> :ok
      {{name, arguments}, count} -> {:error, {:fatal, {:repeated_tool_call_detected, name, display_arguments(arguments), count}}}
    end
  end

  defp repeated_call_counts(existing, calls) do
    Enum.reduce(calls, existing, fn call, acc ->
      Map.update(acc, {call.name, ToolCall.canonical_arguments(call.arguments)}, 1, &(&1 + 1))
    end)
  end

  defp initial_messages(session) do
    case Map.get(session.dispatch_frame, "messages") do
      messages when is_list(messages) ->
        messages

      _ ->
        [%{"role" => "user", "content" => Map.get(session.dispatch_frame, "prompt", "")}]
    end
  end

  defp assistant_tool_call_messages(calls) do
    [
      %{
        "role" => "assistant",
        "content" => "",
        "tool_calls" =>
          Enum.map(calls, fn call ->
            %{
              "id" => call.id,
              "type" => "function",
              "function" => %{"name" => call.name, "arguments" => Jason.encode!(call.arguments)}
            }
          end)
      }
    ]
  end

  defp normalize_progress(%{"type" => "progress", "event" => event} = frame), do: normalize_backend_event(event, frame)
  defp normalize_progress(%{"event" => event} = frame), do: normalize_backend_event(event, frame)
  defp normalize_progress(%{event: event} = frame), do: normalize_backend_event(to_string(event), stringify_keys(frame))
  defp normalize_progress(_frame), do: :ignore

  defp normalize_backend_event("message.delta", frame) do
    text = Map.get(frame, "text") || get_in(frame, ["payload", "text"]) || ""
    {:event, %{event: :notification, payload: %{"method" => "message.delta", "params" => %{"textDelta" => text}}}, text}
  end

  defp normalize_backend_event("tool.started", frame), do: {:event, %{event: :tool_call_started, payload: frame}, ""}
  defp normalize_backend_event("tool.completed", frame), do: {:event, %{event: :tool_call_completed, payload: frame}, ""}

  defp normalize_backend_event("error", frame) do
    {retryable?, reason} = classify_error(frame)
    {:failed, retryable?, reason}
  end

  defp normalize_backend_event(_event, _frame), do: :ignore

  defp emit_event(%{on_message: on_message}, event) when is_function(on_message, 1) do
    case Contract.normalize_event(event) do
      {:ok, normalized} -> on_message.(normalized)
      {:error, reason} -> Logger.warning("tool_calling_loop_dropped_event reason=#{inspect(reason)} event=#{inspect(event)}")
    end
  end

  defp emit_event(_session, _event), do: :ok

  defp normalize_config(config) do
    Map.merge(@default_config, %{
      max_iterations: positive_integer(map_value(config, :max_iterations), @default_config.max_iterations),
      timeout_per_tool_ms: positive_integer(map_value(config, :timeout_per_tool_ms), @default_config.timeout_per_tool_ms),
      total_timeout_ms: positive_integer(map_value(config, :total_timeout_ms), @default_config.total_timeout_ms)
    })
  end

  defp positive_integer(value, _default) when is_integer(value) and value > 0, do: value
  defp positive_integer(_value, default), do: default

  defp remaining_total_timeout_ms(config, state), do: config.total_timeout_ms - (monotonic_ms() - state.started_at)
  defp monotonic_ms, do: System.monotonic_time(:millisecond)

  defp complete_output(frame, fallback) do
    Map.get(frame, "output_text") || Map.get(frame, :output_text) || Map.get(frame, "output") || Map.get(frame, :output) || fallback
  end

  defp classify_error(frame) when is_map(frame) do
    Session.classify_error(frame)
  end

  defp display_arguments(arguments) when is_binary(arguments) do
    case Jason.decode(arguments) do
      {:ok, decoded} -> decoded
      {:error, _reason} -> arguments
    end
  end

  defp display_arguments(arguments), do: arguments

  defp map_value(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, to_string(key))
  end

  defp map_value(_map, _key), do: nil

  defp stringify_keys(map) when is_map(map), do: Map.new(map, fn {key, value} -> {to_string(key), value} end)
end
