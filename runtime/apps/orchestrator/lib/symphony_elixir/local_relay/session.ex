defmodule SymphonyElixir.LocalRelay.Session do
  @moduledoc """
  Generic local relay dispatch and receive loop.

  Callers provide a handler module that translates relay frames into the
  caller-specific response shape. This module owns correlation dispatch,
  continuation delivery, timeout cancellation, and typed relay error
  classification.
  """

  alias SymphonyElixir.LocalRelay.Registry

  @default_timeout_ms 300_000
  @error_codes %{
    "local_runtime_offline" => :local_runtime_offline,
    "local_runner_busy" => :local_runner_busy,
    "local_runner_timeout" => :local_runner_timeout,
    "endpoint_unreachable" => :endpoint_unreachable,
    "model_not_found" => :model_not_found,
    "capability_missing" => :capability_missing,
    "context_overflow" => :context_overflow,
    "generation_timeout" => :generation_timeout,
    "local_runner_protocol_error" => :local_runner_protocol_error
  }

  @type dispatch_mode :: :dispatch | :send_frame | :already_dispatched
  @type handler_result ::
          {:continue, map()}
          | {:ok, map()}
          | {:error, term()}

  @callback init(map()) :: map()
  @callback handle_frame(atom(), map(), map()) :: handler_result()
  @callback timeout_ms(map()) :: pos_integer()

  @spec run_turn(map(), module(), keyword()) :: {:ok, map()} | {:error, term()}
  def run_turn(context, handler, opts \\ []) when is_map(context) and is_atom(handler) do
    correlation_id = Map.fetch!(context, :correlation_id)
    handler_state = handler.init(context)

    with {:ok, start_frame} <- start_dispatch(context, opts),
         {:continue, handler_state} <- handle_started(handler, start_frame, handler_state) do
      await(correlation_id, handler, handler_state, timeout_ms(handler, handler_state))
    end
  end

  @spec dispatch(map()) :: {:ok, map()} | {:error, term()}
  def dispatch(%{workspace_id: workspace_id, target_runner_kind: runner_kind, frame: frame, correlation_id: correlation_id}) do
    case Registry.dispatch(workspace_id, runner_kind, frame) do
      {:ok, ^correlation_id, helper} -> {:ok, helper}
      {:error, reason} -> relay_error(reason)
    end
  end

  @spec send_frame(String.t(), map()) :: :ok | {:error, term()}
  def send_frame(correlation_id, frame) when is_binary(correlation_id) and is_map(frame) do
    case Registry.send_frame(correlation_id, frame) do
      :ok -> :ok
      {:error, :local_runner_protocol_error} -> {:error, {:retryable, :local_runtime_offline}}
    end
  end

  @spec await_frame(String.t(), non_neg_integer()) ::
          {:ok, atom(), map()} | {:error, {:retryable, :local_runner_timeout}}
  def await_frame(correlation_id, timeout_ms) when is_binary(correlation_id) and is_integer(timeout_ms) do
    receive do
      {:local_relay_progress, ^correlation_id, frame} -> {:ok, :progress, frame}
      {:local_relay_complete, ^correlation_id, frame} -> {:ok, :complete, frame}
      {:local_relay_error, ^correlation_id, frame} -> {:ok, :error, frame}
      {:local_relay_tool_call_request, ^correlation_id, frame} -> {:ok, :tool_call_request, frame}
      {:local_relay_tool_call_result, ^correlation_id, frame} -> {:ok, :tool_call_result, frame}
    after
      timeout_ms ->
        Registry.cancel(correlation_id)
        {:error, {:retryable, :local_runner_timeout}}
    end
  end

  @spec classify_error(map()) :: {boolean(), atom()}
  def classify_error(frame) when is_map(frame) do
    code =
      Map.get(frame, "error_code") ||
        Map.get(frame, :error_code) ||
        Map.get(frame, "code") ||
        Map.get(frame, :code) ||
        "local_runner_protocol_error"

    reason = normalize_error_code(code)
    {retryable_for(frame, reason), reason}
  end

  @spec typed_error?(term()) :: boolean()
  def typed_error?(error), do: error in Map.values(@error_codes)

  @spec complete_output(map(), String.t()) :: term()
  def complete_output(frame, fallback) when is_map(frame) do
    get_in(frame, ["payload", "params", "output"]) ||
      get_in(frame, [:payload, :params, :output]) ||
      Map.get(frame, "output_text") ||
      Map.get(frame, :output_text) ||
      Map.get(frame, "output") ||
      Map.get(frame, :output) ||
      fallback
  end

  @spec frame_usage(map()) :: map() | nil
  def frame_usage(frame) when is_map(frame) do
    get_in(frame, ["payload", "params", "usage"]) ||
      get_in(frame, [:payload, :params, :usage]) ||
      Map.get(frame, "usage") ||
      Map.get(frame, :usage)
  end

  @spec frame_metadata(map()) :: map()
  def frame_metadata(frame) when is_map(frame), do: Map.get(frame, "metadata") || Map.get(frame, :metadata) || %{}

  defp start_dispatch(context, opts) do
    case Keyword.get(opts, :dispatch, :dispatch) do
      :dispatch ->
        case dispatch(context) do
          {:ok, helper} ->
            {:ok, %{"correlation_id" => Map.fetch!(context, :correlation_id), "helper" => helper}}

          {:error, reason} ->
            {:error, reason}
        end

      :send_frame ->
        case send_frame(Map.fetch!(context, :correlation_id), Map.fetch!(context, :frame)) do
          :ok -> {:ok, nil}
          {:error, reason} -> {:error, reason}
        end

      :already_dispatched ->
        {:ok, nil}
    end
  end

  defp handle_started(_handler, nil, state), do: {:continue, state}
  defp handle_started(handler, frame, state), do: handler.handle_frame(:started, frame, state)

  defp await(correlation_id, handler, state, timeout_ms) do
    case await_frame(correlation_id, timeout_ms) do
      {:ok, event, frame} ->
        case handler.handle_frame(event, frame, state) do
          {:continue, state} -> await(correlation_id, handler, state, timeout_ms)
          terminal -> terminal
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp timeout_ms(handler, state) do
    case handler.timeout_ms(state) do
      value when is_integer(value) and value > 0 -> value
      _ -> @default_timeout_ms
    end
  end

  defp relay_error(:local_runtime_offline), do: {:error, {:retryable, :local_runtime_offline}}
  defp relay_error(:local_runner_busy), do: {:error, {:retryable, :local_runner_busy}}
  defp relay_error(:local_runner_protocol_error), do: {:error, {:fatal, :local_runner_protocol_error}}
  defp relay_error(reason), do: {:error, {:fatal, reason}}

  defp normalize_error_code(code) when is_atom(code) do
    if typed_error?(code), do: code, else: :local_runner_protocol_error
  end

  defp normalize_error_code(code) when is_binary(code) do
    Map.get(@error_codes, String.trim(code), :local_runner_protocol_error)
  end

  defp normalize_error_code(_code), do: :local_runner_protocol_error

  defp retryable_for(frame, reason) do
    case Map.fetch(frame, "retryable") do
      {:ok, value} when is_boolean(value) ->
        value

      _ ->
        case Map.fetch(frame, :retryable) do
          {:ok, value} when is_boolean(value) -> value
          _ -> reason in retryable_error_codes()
        end
    end
  end

  defp retryable_error_codes do
    [:local_runtime_offline, :local_runner_busy, :local_runner_timeout, :endpoint_unreachable, :generation_timeout]
  end
end
