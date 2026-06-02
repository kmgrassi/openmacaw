defmodule SymphonyElixir.Schema.OpenClawFrame do
  @moduledoc """
  Validates inbound OpenClaw WebSocket runner frames.

  OpenClaw currently sends both gateway chat event envelopes and direct backend
  event frames. This module keeps that wire-boundary validation separate from
  runner-contract normalization.
  """

  defmodule Chat do
    @moduledoc "Validated gateway chat event frame."

    @type state :: :streaming | :delta | :final | :error | :aborted
    @type t :: %__MODULE__{
            state: state(),
            payload: map(),
            raw: map()
          }

    defstruct [:state, :payload, :raw]
  end

  defmodule BackendEvent do
    @moduledoc "Validated backend event frame."

    @type event ::
            :run_started
            | :message_delta
            | :message_completed
            | :tool_started
            | :tool_completed
            | :warning
            | :error
            | :run_completed
            | :run_failed
            | :run_cancelled

    @type t :: %__MODULE__{
            event: event(),
            raw: map()
          }

    defstruct [:event, :raw]
  end

  @type t :: Chat.t() | BackendEvent.t()

  @backend_events %{
    "run.started" => :run_started,
    "message.delta" => :message_delta,
    "message.completed" => :message_completed,
    "tool.started" => :tool_started,
    "tool.completed" => :tool_completed,
    "warning" => :warning,
    "error" => :error,
    "run.completed" => :run_completed,
    "run.failed" => :run_failed,
    "run.cancelled" => :run_cancelled
  }

  @spec validate(term()) :: {:ok, t()} | {:error, term()}
  def validate(%{"type" => "event", "event" => "chat", "payload" => payload} = frame) when is_map(payload) do
    with {:ok, state} <- chat_state(Map.get(payload, "state")),
         :ok <- validate_chat_payload(state, payload) do
      {:ok, %Chat{state: state, payload: payload, raw: frame}}
    end
  end

  def validate(%{"type" => "event", "event" => "chat"}), do: {:error, {:invalid_field, "payload", :expected_map}}

  def validate(%{"type" => type} = frame) when is_binary(type) do
    validate_backend_event(type, frame)
  end

  def validate(%{"event" => event} = frame) when is_binary(event) do
    validate_backend_event(event, frame)
  end

  def validate(frame) when is_map(frame), do: {:error, :missing_event_type}
  def validate(_frame), do: {:error, :invalid_frame}

  defp chat_state("streaming"), do: {:ok, :streaming}
  defp chat_state("delta"), do: {:ok, :delta}
  defp chat_state("final"), do: {:ok, :final}
  defp chat_state("error"), do: {:ok, :error}
  defp chat_state("aborted"), do: {:ok, :aborted}
  defp chat_state(state) when is_binary(state), do: {:error, {:unsupported_chat_state, state}}
  defp chat_state(_state), do: {:error, {:invalid_field, "payload.state", :expected_string}}

  defp validate_chat_payload(state, payload) when state in [:streaming, :delta, :final] do
    validate_optional_string(payload, "text")
  end

  defp validate_chat_payload(:error, _payload), do: :ok

  defp validate_chat_payload(:aborted, _payload), do: :ok

  defp validate_backend_event(event_type, frame) do
    with {:ok, event} <- backend_event(event_type),
         :ok <- validate_backend_payload(event, frame) do
      {:ok, %BackendEvent{event: event, raw: frame}}
    end
  end

  defp backend_event(event_type) do
    case Map.fetch(@backend_events, event_type) do
      {:ok, event} -> {:ok, event}
      :error -> {:error, {:unsupported_event_type, event_type}}
    end
  end

  defp validate_backend_payload(event, frame) when event in [:message_delta, :message_completed] do
    validate_optional_string(frame, "text")
  end

  defp validate_backend_payload(:warning, frame), do: validate_optional_string(frame, "message")

  defp validate_backend_payload(:error, frame) do
    with :ok <- validate_optional_string(frame, "message"),
         :ok <- validate_optional_boolean(frame, "retryable") do
      :ok
    end
  end

  defp validate_backend_payload(:run_completed, frame), do: validate_optional_string(frame, "output")
  defp validate_backend_payload(:run_failed, _frame), do: :ok
  defp validate_backend_payload(_event, _frame), do: :ok

  defp validate_optional_string(frame, key) do
    case Map.get(frame, key) do
      value when is_binary(value) -> :ok
      nil -> :ok
      _other -> {:error, {:invalid_field, key, :expected_string}}
    end
  end

  defp validate_optional_boolean(frame, key) do
    case Map.get(frame, key) do
      value when is_boolean(value) -> :ok
      nil -> :ok
      _other -> {:error, {:invalid_field, key, :expected_boolean}}
    end
  end
end
