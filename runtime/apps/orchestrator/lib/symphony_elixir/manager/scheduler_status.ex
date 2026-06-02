defmodule SymphonyElixir.Manager.SchedulerStatus do
  @moduledoc """
  Pure status and observability helpers for `SymphonyElixir.Manager.Scheduler`.
  """

  defstruct [
    :status,
    :workspace_id,
    :agent_id,
    :missing,
    :min_cadence_ms,
    :last_tick_at,
    :last_decision_count,
    :idle_reason,
    :last_error,
    :trace_id,
    :provider,
    :model,
    :runner,
    :consecutive_error_count,
    session_details: %{}
  ]

  @max_error_message_length 1_024

  @type health ::
          :idle_awaiting_config
          | :idle_awaiting_credential
          | :running
          | :unhealthy
          | :error

  @type t :: %__MODULE__{
          status: health(),
          workspace_id: String.t(),
          agent_id: String.t(),
          missing: [String.t()],
          min_cadence_ms: pos_integer(),
          last_tick_at: DateTime.t() | nil,
          last_decision_count: non_neg_integer(),
          idle_reason: atom() | nil,
          last_error: map() | nil,
          trace_id: String.t() | nil,
          provider: String.t() | nil,
          model: String.t() | nil,
          runner: String.t() | nil,
          consecutive_error_count: non_neg_integer(),
          session_details: map()
        }

  @spec compute(map()) :: t()
  def compute(state) do
    %__MODULE__{
      status: health(state),
      workspace_id: state.workspace_id,
      agent_id: state.agent_id,
      missing: missing_requirements(state),
      min_cadence_ms: state.min_cadence_ms,
      last_tick_at: state.last_tick_at,
      last_decision_count: state.last_decision_count,
      idle_reason: state.idle_reason,
      last_error: state.last_error || idle_error(state),
      trace_id: state.trace_id,
      provider: provider(state),
      model: model(state),
      runner: runner_name(state.session),
      consecutive_error_count: state.consecutive_error_count,
      session_details: state.session_details || %{}
    }
  end

  @spec to_payload(t()) :: map()
  def to_payload(%__MODULE__{} = status) do
    %{
      status: status.status,
      workspace_id: status.workspace_id,
      agent_id: status.agent_id,
      missing: status.missing,
      min_cadence_ms: status.min_cadence_ms,
      last_tick_at: status.last_tick_at,
      last_decision_count: status.last_decision_count,
      idle_reason: status.idle_reason,
      last_error: status.last_error,
      trace_id: status.trace_id
    }
    |> Map.merge(status.session_details)
    |> Map.put(:agent_id, status.agent_id)
    |> put_new_non_nil(:provider, status.provider || "openai")
    |> put_new_non_nil(:model, status.model)
    |> maybe_put(:runner, status.runner)
  end

  @spec log_fields(t(), String.t() | nil) :: map()
  def log_fields(%__MODULE__{} = status, trace_id) do
    %{
      workspace_id: status.workspace_id,
      agent_id: status.agent_id,
      provider: status.provider || "openai",
      model: status.model,
      trace_id: trace_id,
      status: status.status,
      scheduler_health: status.status,
      idle_reason: status.idle_reason,
      last_decision_count: status.last_decision_count,
      consecutive_error_count: status.consecutive_error_count,
      last_error_kind: if(status.last_error, do: status.last_error.kind),
      last_error_code: if(status.last_error, do: status.last_error.error_code)
    }
  end

  @spec skip_reason(t()) :: atom()
  def skip_reason(%__MODULE__{idle_reason: :config_missing}), do: :disabled_manager
  def skip_reason(%__MODULE__{idle_reason: :credential_missing}), do: :missing_session
  def skip_reason(%__MODULE__{idle_reason: :credential_unresolved}), do: :missing_session
  def skip_reason(%__MODULE__{idle_reason: :manager_session_error}), do: :invalid_profile
  def skip_reason(%__MODULE__{idle_reason: nil}), do: :missing_session
  def skip_reason(%__MODULE__{}), do: :disabled_manager

  @spec log_level(t()) :: Logger.level()
  def log_level(%__MODULE__{status: :running}), do: :info
  def log_level(%__MODULE__{status: :idle_awaiting_config}), do: :info
  def log_level(%__MODULE__{status: :idle_awaiting_credential}), do: :info
  def log_level(%__MODULE__{status: :error}), do: :warning
  def log_level(%__MODULE__{status: :unhealthy}), do: :error

  @spec normalize_error(term()) :: map() | nil
  def normalize_error(nil), do: nil

  def normalize_error(reason) do
    reason
    |> exception_log_fields()
    |> Map.merge(%{
      kind: error_kind(reason),
      error_code: error_code(reason),
      message: inspect(reason),
      retryable: retryable_error?(reason)
    })
  end

  @spec exception_log_fields(term(), keyword()) :: map()
  def exception_log_fields(reason, opts \\ [])

  def exception_log_fields({:exception, module, message}, opts) do
    %{
      error_class: exception_class(module),
      error_message: truncate_error_message(message),
      tick_phase: Keyword.get(opts, :tick_phase)
    }
    |> drop_nil_values()
  end

  def exception_log_fields(%{__struct__: module, __exception__: true} = exception, opts)
      when is_atom(module) do
    exception_log_fields({:exception, module, Exception.message(exception)}, opts)
  end

  def exception_log_fields(_reason, _opts), do: %{}

  @spec error_code(term()) :: String.t()
  def error_code({:retryable, reason}), do: error_code(reason)
  def error_code({:fatal, reason}), do: error_code(reason)
  def error_code({:exception, _module, _message}), do: "manager_scheduler_exception"
  def error_code(:manager_runner_not_configured), do: "manager_runner_not_configured"
  def error_code(:provider_timeout), do: "manager_provider_timeout"
  def error_code({:invalid_manager_runner, _runner}), do: "invalid_manager_profile"
  def error_code({:adapter_failed, _reason}), do: "manager_session_resolution_failed"
  def error_code({kind, _reason}) when kind in [:error, :exit], do: "manager_scheduler_failure"
  def error_code(reason) when is_atom(reason), do: "manager_#{reason}"
  def error_code(_reason), do: "manager_scheduler_failure"

  @spec retryable_error?(term()) :: boolean()
  def retryable_error?({:retryable, _reason}), do: true
  def retryable_error?(_reason), do: false

  defp health(%{consecutive_error_count: count}) when count >= 3, do: :unhealthy
  defp health(%{last_error: error}) when not is_nil(error), do: :error
  defp health(%{idle_reason: :manager_session_error}), do: :error

  defp health(%{idle_reason: nil, session: session}) when is_map(session) do
    if Map.has_key?(session, :runner), do: :running, else: :idle_awaiting_config
  end

  defp health(%{idle_reason: :config_missing}), do: :idle_awaiting_config

  defp health(%{idle_reason: reason})
       when reason in [:credential_missing, :credential_unresolved],
       do: :idle_awaiting_credential

  defp health(_state), do: :idle_awaiting_config

  defp missing_requirements(%{idle_reason: :config_missing}), do: ["config"]
  defp missing_requirements(%{idle_reason: :credential_missing}), do: ["credential"]
  defp missing_requirements(%{idle_reason: :credential_unresolved}), do: ["credential"]
  defp missing_requirements(%{idle_reason: :manager_session_error}), do: []

  defp missing_requirements(%{idle_reason: nil, session: session}) when is_map(session) do
    if Map.has_key?(session, :runner), do: [], else: ["runner"]
  end

  defp missing_requirements(_state), do: []

  defp idle_error(%{idle_reason: :manager_session_error, session_error: %{} = error}), do: error

  defp idle_error(%{idle_reason: :manager_session_error, session_details: details}) do
    details
    |> Map.get(:reason, :manager_session_error)
    |> normalize_error()
  end

  defp idle_error(_state), do: nil

  defp error_kind({:retryable, _reason}), do: "provider_failure"
  defp error_kind({:fatal, _reason}), do: "provider_failure"
  defp error_kind({:exception, _module, _message}), do: "runtime_exception"
  defp error_kind(:manager_runner_not_configured), do: "configuration"
  defp error_kind(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp error_kind({kind, _reason}) when is_atom(kind), do: Atom.to_string(kind)
  defp error_kind(_reason), do: "runtime_error"

  defp provider(state) do
    Map.get(state.session_details, :provider) ||
      session_value(state.session, :provider) ||
      "openai"
  end

  defp model(state) do
    Map.get(state.session_details, :model) ||
      session_value(state.session, :model)
  end

  defp runner_name(%{runner: runner}) when is_atom(runner), do: inspect(runner)
  defp runner_name(_session), do: nil

  defp session_value(session, key) when is_map(session) do
    Map.get(session, key) || Map.get(session, Atom.to_string(key))
  end

  defp session_value(_session, _key), do: nil

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp put_new_non_nil(map, _key, nil), do: map
  defp put_new_non_nil(map, key, value), do: Map.put_new(map, key, value)

  defp exception_class(module) when is_atom(module) do
    module
    |> Module.split()
    |> Enum.join(".")
  end

  defp exception_class(module), do: inspect(module)

  defp truncate_error_message(message) do
    message
    |> to_string()
    |> String.slice(0, @max_error_message_length)
  end

  defp drop_nil_values(map) do
    Map.reject(map, fn {_key, value} -> is_nil(value) end)
  end
end
