defmodule SymphonyElixir.RuntimeLog do
  @moduledoc """
  Shared structured runtime logging helpers.

  Runtime logs are emitted as JSON payloads so platform, launcher, gateway,
  worker, and tool events share one vocabulary and can be joined by trace ids.
  """

  require Logger

  alias SymphonyElixir.MapUtils

  @sensitive_key_fragments ~w(
    api_key
    authorization
    bearer
    credential
    password
    secret
    token
  )

  @required_event_fields %{
    "model_call_started" => ~w(trace_id run_id provider model),
    "model_call_completed" => ~w(trace_id run_id provider model duration_ms),
    "model_call_failed" => ~w(trace_id run_id provider model error_code),
    "postgrest_request_started" => ~w(trace_id caller table method),
    "postgrest_request_completed" => ~w(trace_id caller table method status_code duration_ms),
    "postgrest_request_failed" => ~w(trace_id caller table method error_code duration_ms),
    "tool_call_started" => ~w(trace_id run_id turn_id tool_call_id tool_name),
    "tool_call_completed" => ~w(trace_id run_id turn_id tool_call_id tool_name duration_ms),
    "tool_call_failed" => ~w(trace_id run_id turn_id tool_call_id tool_name error_code)
  }

  @spec log(Logger.level(), String.t() | atom(), map() | keyword()) :: :ok
  def log(level, event, fields \\ %{}) when is_atom(level) do
    event_name = normalize_event(event)

    payload =
      fields
      |> normalize_fields()
      |> Map.put("event", event_name)
      |> Map.put_new("timestamp", DateTime.utc_now() |> DateTime.to_iso8601())
      |> put_missing_required_fields(event_name)
      |> redact()
      |> MapUtils.drop_nil_values()
      |> encode_safe()

    Logger.log(level, fn -> encode_payload(payload) end)
    :ok
  end

  @spec timed(Logger.level(), String.t() | atom(), map() | keyword(), (-> result)) :: result when result: term()
  def timed(level, event, fields \\ %{}, fun) when is_atom(level) and is_function(fun, 0) do
    started_at = System.monotonic_time()
    result = fun.()

    duration_ms = duration_ms_since(started_at)
    log(level, event, Map.put(normalize_fields(fields), "duration_ms", duration_ms))

    result
  end

  @spec with_error_log(Logger.level(), String.t() | atom(), map() | keyword(), (-> result)) :: result when result: term()
  def with_error_log(level, event, fields \\ %{}, fun) when is_atom(level) and is_function(fun, 0) do
    try do
      case fun.() do
        {:error, reason} = error ->
          log(level, event, error_fields(fields, "operation_failed", reason))
          error

        other ->
          other
      end
    rescue
      exception ->
        log(
          level,
          event,
          fields
          |> error_fields("exception", Exception.message(exception))
          |> Map.put("exception", exception.__struct__ |> Module.split() |> Enum.join("."))
        )

        reraise exception, __STACKTRACE__
    catch
      kind, reason ->
        log(level, event, error_fields(fields, "operation_#{kind}", reason))
        :erlang.raise(kind, reason, __STACKTRACE__)
    end
  end

  @spec required_fields_for(String.t() | atom()) :: [String.t()]
  def required_fields_for(event) do
    Map.get(@required_event_fields, normalize_event(event), [])
  end

  @spec trace_id_from_headers(map() | list() | nil) :: String.t() | nil
  def trace_id_from_headers(headers) do
    headers
    |> header_map()
    |> first_present(["x-trace-id", "trace-id", "traceparent"])
    |> normalize_trace_header()
  end

  @spec trace_id_from_conn(Plug.Conn.t()) :: String.t() | nil
  def trace_id_from_conn(%Plug.Conn{} = conn) do
    trace_id_from_headers(conn.req_headers)
  end

  @spec ensure_trace_id(String.t() | nil) :: String.t()
  def ensure_trace_id(trace_id) when is_binary(trace_id) do
    case String.trim(trace_id) do
      "" -> generate_trace_id()
      value -> value
    end
  end

  def ensure_trace_id(_trace_id), do: generate_trace_id()

  @spec generate_trace_id() :: String.t()
  def generate_trace_id do
    "trc_" <> (:crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower))
  end

  @doc """
  Run `fun` with `trace_id` bound on the current process so downstream
  log emitters (e.g. `PostgRESTClient`) can pick it up via
  `Process.get(:symphony_trace_id)`.

  Restores the previous value (or removes the key entirely) when `fun`
  returns or raises. If `trace_id` is `nil`, a fresh trace id is
  generated so callers do not need an `ensure_trace_id` step.
  """
  @spec with_operation_trace_id(String.t() | nil, (-> result)) :: result when result: term()
  def with_operation_trace_id(trace_id, fun) when is_function(fun, 0) do
    trace_id = ensure_trace_id(trace_id)
    previous = Process.get(:symphony_trace_id)
    Process.put(:symphony_trace_id, trace_id)

    try do
      fun.()
    after
      case previous do
        nil -> Process.delete(:symphony_trace_id)
        value -> Process.put(:symphony_trace_id, value)
      end
    end
  end

  @spec generate_connection_id() :: String.t()
  def generate_connection_id do
    "conn_" <> (:crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower))
  end

  @spec scope_fields(map() | nil) :: map()
  def scope_fields(scope) when is_map(scope) do
    %{
      agent_id: Map.get(scope, :agent_id) || Map.get(scope, "agent_id"),
      workspace_id: Map.get(scope, :workspace_id) || Map.get(scope, "workspace_id"),
      session_key: Map.get(scope, :session_key) || Map.get(scope, "session_key"),
      user_id: Map.get(scope, :user_id) || Map.get(scope, "user_id")
    }
    |> MapUtils.drop_nil_values()
  end

  def scope_fields(_scope), do: %{}

  defp normalize_fields(fields) when is_list(fields), do: fields |> Map.new() |> normalize_fields()

  defp normalize_fields(fields) when is_map(fields) do
    Map.new(fields, fn {key, value} ->
      {normalize_key(key), normalize_field_value(value)}
    end)
  end

  defp normalize_fields(_fields), do: %{}

  defp normalize_event(event) when is_atom(event), do: event |> Atom.to_string() |> normalize_event()

  defp normalize_event(event) when is_binary(event) do
    event
    |> String.trim()
    |> Macro.underscore()
    |> String.replace(~r/[^a-zA-Z0-9]+/, "_")
    |> String.trim("_")
  end

  defp normalize_event(event), do: event |> inspect() |> normalize_event()

  defp normalize_key(key) when is_atom(key), do: key |> Atom.to_string() |> normalize_key()

  defp normalize_key(key) when is_binary(key) do
    key
    |> String.trim()
    |> Macro.underscore()
    |> String.replace(~r/[^a-zA-Z0-9]+/, "_")
    |> String.trim("_")
  end

  defp normalize_key(key), do: key |> to_string() |> normalize_key()

  defp normalize_field_value(%DateTime{} = value), do: value
  defp normalize_field_value(%NaiveDateTime{} = value), do: value
  defp normalize_field_value(%Date{} = value), do: value
  defp normalize_field_value(%Time{} = value), do: value
  defp normalize_field_value(%{} = map), do: normalize_fields(map)
  defp normalize_field_value(values) when is_list(values), do: Enum.map(values, &normalize_field_value/1)
  defp normalize_field_value(value), do: value

  defp put_missing_required_fields(payload, event_name) do
    missing_fields =
      event_name
      |> required_fields_for()
      |> Enum.reject(&present_field?(payload, &1))

    if missing_fields == [] do
      payload
    else
      Map.put(payload, "missing_required_fields", missing_fields)
    end
  end

  defp present_field?(payload, field) do
    case Map.get(payload, field) do
      nil -> false
      "" -> false
      [] -> false
      _ -> true
    end
  end

  defp duration_ms_since(started_at) do
    System.convert_time_unit(System.monotonic_time() - started_at, :native, :millisecond)
  end

  defp error_fields(fields, error_code, reason) do
    fields
    |> normalize_fields()
    |> Map.put_new("error_code", error_code)
    |> Map.put("reason", safe_reason(reason))
  end

  defp safe_reason(reason) when is_binary(reason), do: reason
  defp safe_reason(reason), do: inspect(reason, printable_limit: 500, limit: 50)

  defp header_map(headers) when is_map(headers) do
    Map.new(headers, fn {key, value} -> {normalize_header_name(key), value} end)
  end

  defp header_map(headers) when is_list(headers) do
    Map.new(headers, fn {key, value} -> {normalize_header_name(key), value} end)
  end

  defp header_map(_headers), do: %{}

  defp normalize_header_name(key) when is_atom(key), do: key |> Atom.to_string() |> normalize_header_name()
  defp normalize_header_name(key) when is_binary(key), do: String.downcase(key)
  defp normalize_header_name(key), do: key |> to_string() |> String.downcase()

  defp first_present(headers, names) do
    Enum.find_value(names, fn name ->
      case Map.get(headers, name) do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end
    end)
  end

  defp normalize_trace_header("00-" <> rest) do
    case String.split(rest, "-") do
      [trace_id, _span_id, _flags | _] when byte_size(trace_id) == 32 -> trace_id
      _ -> "00-" <> rest
    end
  end

  defp normalize_trace_header(value) when is_binary(value), do: String.trim(value)
  defp normalize_trace_header(_value), do: nil

  defp redact(%{} = map) do
    Map.new(map, fn {key, value} ->
      if sensitive_key?(key) do
        {key, "[REDACTED]"}
      else
        {key, redact(value)}
      end
    end)
  end

  defp redact(values) when is_list(values), do: Enum.map(values, &redact/1)
  defp redact(value), do: value

  defp sensitive_key?(key) do
    key_text =
      key
      |> to_string()
      |> String.downcase()

    key_text not in ["credential_scope", "credential_id_suffix"] and
      Enum.any?(@sensitive_key_fragments, &String.contains?(key_text, &1))
  end

  defp encode_safe(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp encode_safe(%NaiveDateTime{} = value), do: NaiveDateTime.to_iso8601(value)
  defp encode_safe(%Date{} = value), do: Date.to_iso8601(value)
  defp encode_safe(%Time{} = value), do: Time.to_iso8601(value)
  defp encode_safe(%{} = map), do: Map.new(map, fn {key, value} -> {key, encode_safe(value)} end)
  defp encode_safe(values) when is_list(values), do: Enum.map(values, &encode_safe/1)
  defp encode_safe(value) when is_binary(value) or is_number(value) or is_boolean(value) or is_nil(value), do: value
  defp encode_safe(pid) when is_pid(pid), do: inspect(pid)
  defp encode_safe(reference) when is_reference(reference), do: inspect(reference)
  defp encode_safe(function) when is_function(function), do: inspect(function)
  defp encode_safe(port) when is_port(port), do: inspect(port)
  defp encode_safe(atom) when is_atom(atom), do: Atom.to_string(atom)
  defp encode_safe(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> encode_safe()
  defp encode_safe(value), do: inspect(value, printable_limit: 500, limit: 50)

  defp encode_payload(payload) do
    case Jason.encode(payload) do
      {:ok, json} ->
        json

      {:error, reason} ->
        fallback = %{
          "event" => "runtime_log_encoding_failed",
          "timestamp" => DateTime.utc_now() |> DateTime.to_iso8601(),
          "error_code" => "runtime_log_encoding_failed",
          "reason" => inspect(reason, printable_limit: 500, limit: 50),
          "payload" => payload |> inspect(printable_limit: 500, limit: 50) |> redact_text()
        }

        Jason.encode!(fallback)
    end
  end

  defp redact_text(text) do
    Enum.reduce(@sensitive_key_fragments, text, fn fragment, acc ->
      Regex.replace(~r/(#{Regex.escape(fragment)}[^,\s}\]]*)/i, acc, "[REDACTED]")
    end)
  end
end
