defmodule SymphonyElixir.LocalRuntime.Diagnostics do
  @moduledoc """
  Observability helpers for local runtime relay-backed runs.

  The relay registry is intentionally not implemented here. This module accepts
  map-shaped helper snapshots so the in-process relay registry from PR2/PR5 can
  plug in directly, while tests and local debug tools can provide the same shape
  through `:local_runtime_diagnostics_source`.
  """

  alias SymphonyElixir.RuntimeLog

  @safe_failure_reasons ~w(
    local_runtime_offline
    local_runtime_token_revoked
    local_runner_busy
    local_runner_timeout
    endpoint_unreachable
    model_not_found
    capability_missing
    context_overflow
    generation_timeout
    local_runner_protocol_error
  )

  @retryable_failure_reasons ~w(
    local_runtime_offline
    local_runner_busy
    local_runner_timeout
    endpoint_unreachable
    generation_timeout
    local_runner_protocol_error
  )

  @sensitive_key_fragments ~w(
    api_key
    authorization
    bearer
    credential
    endpoint
    password
    secret
    token
    url
  )

  @spec health_payload(map()) :: map()
  def health_payload(params \\ %{}) when is_map(params) do
    snapshot = source_snapshot()
    helpers = snapshot |> Map.get("helpers", []) |> Enum.map(&helper_payload/1)
    diagnostics = diagnose(Enum.map(helpers, &stringify_keys/1), params)

    %{
      generated_at: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      ok: diagnostics["status"] == "healthy",
      status: diagnostics["status"],
      reason: diagnostics["reason"],
      missing_capabilities: diagnostics["missing_capabilities"],
      helpers: helpers,
      filters: filter_payload(params)
    }
    |> drop_nil_values()
  end

  @spec log_event(Logger.level(), String.t() | atom(), map()) :: :ok
  def log_event(level, event, context) when is_atom(level) and is_map(context) do
    RuntimeLog.log(level, event, log_fields(context))
  end

  @spec log_fields(map()) :: map()
  def log_fields(context) when is_map(context) do
    context = normalize_keys(context)

    %{
      workspace_id: Map.get(context, "workspace_id"),
      agent_id: Map.get(context, "agent_id"),
      run_id: Map.get(context, "run_id"),
      session_id: Map.get(context, "session_id"),
      machine_id: Map.get(context, "machine_id"),
      runner_kind: Map.get(context, "runner_kind"),
      target_runner_kind: Map.get(context, "target_runner_kind"),
      provider: Map.get(context, "provider"),
      model: Map.get(context, "model"),
      capability_snapshot_id: Map.get(context, "capability_snapshot_id"),
      typed_failure_reason: typed_failure_reason(Map.get(context, "typed_failure_reason") || Map.get(context, "reason")),
      capability_snapshot: sanitize(Map.get(context, "capability_snapshot") || Map.get(context, "capabilities"))
    }
    |> drop_nil_values()
  end

  @spec typed_failure_reason(term()) :: String.t() | nil
  def typed_failure_reason(nil), do: nil
  def typed_failure_reason(reason) when is_atom(reason), do: typed_failure_reason(Atom.to_string(reason))

  def typed_failure_reason(reason) when is_binary(reason) do
    reason = String.trim(reason)
    if reason in @safe_failure_reasons, do: reason, else: "local_runner_protocol_error"
  end

  def typed_failure_reason(_reason), do: nil

  @spec retryable_failure?(term()) :: boolean()
  def retryable_failure?(reason), do: typed_failure_reason(reason) in @retryable_failure_reasons

  defp source_snapshot do
    case Application.get_env(:symphony_elixir, :local_runtime_diagnostics_source) do
      fun when is_function(fun, 0) -> fun.()
      %{} = snapshot -> snapshot
      helpers when is_list(helpers) -> %{"helpers" => helpers}
      _other -> presence_snapshot()
    end
    |> normalize_keys()
  end

  defp presence_snapshot do
    if Process.whereis(SymphonyElixir.LocalRelay.Presence) do
      %{"helpers" => SymphonyElixir.LocalRelay.Presence.list()}
    else
      %{"helpers" => []}
    end
  end

  defp diagnose([], _params), do: %{"status" => "degraded", "reason" => "helper_disconnected"}

  defp diagnose(helpers, params) do
    params = normalize_keys(params)
    workspace_id = blank_to_nil(Map.get(params, "workspace_id"))
    target_runner_kind = blank_to_nil(Map.get(params, "target_runner_kind") || Map.get(params, "runner_kind"))
    model = blank_to_nil(Map.get(params, "model"))
    required_capabilities = required_capabilities(params)

    scoped_helpers = filter_by(helpers, "workspace_id", workspace_id)
    online_helpers = Enum.filter(scoped_helpers, &(Map.get(&1, "status") == "online"))
    runners = Enum.flat_map(online_helpers, &Map.get(&1, "runners", []))
    target_runners = filter_by(runners, "runner_kind", target_runner_kind)
    model_runners = filter_runners_by_model(target_runners, model)
    missing_capabilities = missing_capabilities(model_runners, required_capabilities)

    cond do
      scoped_helpers == [] or online_helpers == [] ->
        %{"status" => "degraded", "reason" => "helper_disconnected"}

      target_runner_kind && target_runners == [] ->
        %{"status" => "degraded", "reason" => "target_runner_not_registered"}

      model && model_runners == [] ->
        %{"status" => "degraded", "reason" => "model_unavailable"}

      missing_capabilities != [] ->
        %{"status" => "degraded", "reason" => "capability_mismatch", "missing_capabilities" => missing_capabilities}

      runner_failure_reason(model_runners) ->
        %{"status" => "degraded", "reason" => runner_failure_reason(model_runners)}

      true ->
        %{"status" => "healthy", "reason" => "ready"}
    end
  end

  defp helper_payload(helper) when is_map(helper) do
    helper = normalize_keys(helper)
    connected? = truthy?(Map.get(helper, "connected", Map.get(helper, "online", true)))

    %{
      workspace_id: Map.get(helper, "workspace_id"),
      machine_id: Map.get(helper, "machine_id"),
      status: if(connected?, do: "online", else: "disconnected"),
      disconnected_reason: typed_failure_reason(Map.get(helper, "disconnected_reason")),
      last_seen_at: Map.get(helper, "last_seen_at"),
      runners: helper |> Map.get("runners", []) |> Enum.map(&runner_payload/1),
      active_runs: helper |> Map.get("active_runs", []) |> Enum.map(&run_payload/1)
    }
    |> drop_nil_values()
  end

  defp helper_payload(_helper), do: %{}

  defp runner_payload(runner) when is_map(runner) do
    runner = normalize_keys(runner)
    capabilities = sanitize(Map.get(runner, "capabilities", %{}))

    %{
      runner_kind: Map.get(runner, "runner_kind") || Map.get(runner, "target_runner_kind"),
      target_runner_kind: Map.get(runner, "target_runner_kind"),
      provider: Map.get(runner, "provider"),
      model: Map.get(runner, "model"),
      models: normalize_models(Map.get(runner, "models"), Map.get(runner, "model")),
      status: runner_status(runner),
      typed_failure_reason: typed_failure_reason(Map.get(runner, "typed_failure_reason") || Map.get(runner, "reason")),
      capability_snapshot_id: Map.get(runner, "capability_snapshot_id"),
      capabilities: capabilities,
      endpoint_fingerprint: endpoint_fingerprint(runner)
    }
    |> drop_nil_values()
  end

  defp runner_payload(_runner), do: %{}

  defp run_payload(run) when is_map(run) do
    run
    |> log_fields()
    |> Map.put_new(:status, normalize_status(Map.get(run, :status) || Map.get(run, "status")))
    |> drop_nil_values()
    |> stringify_keys()
  end

  defp run_payload(_run), do: %{}

  defp runner_status(runner) do
    cond do
      truthy?(Map.get(runner, "busy")) -> "busy"
      typed_failure_reason(Map.get(runner, "typed_failure_reason") || Map.get(runner, "reason")) == "endpoint_unreachable" -> "endpoint_unreachable"
      Map.get(runner, "status") in [nil, ""] -> "ready"
      true -> normalize_status(Map.get(runner, "status"))
    end
  end

  defp runner_failure_reason(runners) do
    Enum.find_value(runners, fn runner ->
      case {Map.get(runner, "status"), Map.get(runner, "typed_failure_reason")} do
        {"busy", _} -> "local_runner_busy"
        {"endpoint_unreachable", _} -> "endpoint_unreachable"
        {_, reason} when is_binary(reason) -> reason
        _ -> nil
      end
    end)
  end

  defp required_capabilities(params) do
    params
    |> Map.get("required_capabilities", Map.get(params, "capabilities", []))
    |> case do
      value when is_binary(value) -> value |> String.split(",", trim: true) |> Enum.map(&String.trim/1)
      value when is_list(value) -> Enum.map(value, &to_string/1)
      _ -> []
    end
    |> Enum.reject(&(&1 == ""))
  end

  defp missing_capabilities(_runners, []), do: []
  defp missing_capabilities([], required), do: required

  defp missing_capabilities(runners, required) do
    Enum.reject(required, fn capability ->
      Enum.any?(runners, fn runner ->
        runner
        |> Map.get("capabilities", %{})
        |> capability_supported?(capability)
      end)
    end)
  end

  defp capability_supported?(capabilities, capability) when is_map(capabilities) do
    value = Map.get(capabilities, capability)
    value == true or (is_binary(value) and value not in ["", "false", "unsupported"])
  end

  defp capability_supported?(_capabilities, _capability), do: false

  defp filter_by(values, _key, nil), do: values

  defp filter_by(values, key, value) do
    Enum.filter(values, &(Map.get(&1, key) == value))
  end

  defp filter_runners_by_model(runners, nil), do: runners

  defp filter_runners_by_model(runners, model) do
    Enum.filter(runners, fn runner ->
      Map.get(runner, "model") == model or model in Map.get(runner, "models", [])
    end)
  end

  defp normalize_models(models, _fallback) when is_list(models), do: Enum.map(models, &to_string/1)
  defp normalize_models(_models, fallback) when is_binary(fallback), do: [fallback]
  defp normalize_models(_models, _fallback), do: []

  defp endpoint_fingerprint(runner) do
    endpoint = Map.get(runner, "endpoint") || Map.get(runner, "base_url") || Map.get(runner, "url")

    if is_binary(endpoint) and endpoint != "" do
      "sha256:" <> (:crypto.hash(:sha256, endpoint_without_credentials(endpoint)) |> Base.encode16(case: :lower))
    end
  end

  defp endpoint_without_credentials(endpoint) do
    case URI.parse(endpoint) do
      %URI{} = uri -> URI.to_string(%{uri | userinfo: nil, query: nil, fragment: nil})
      _ -> endpoint
    end
  end

  defp filter_payload(params) do
    params
    |> normalize_keys()
    |> Map.take(["workspace_id", "runner_kind", "target_runner_kind", "provider", "model", "required_capabilities"])
    |> drop_blank_values()
  end

  defp sanitize(%{} = map) do
    Map.new(map, fn {key, value} ->
      if sensitive_key?(key) do
        {key, "[REDACTED]"}
      else
        {key, sanitize(value)}
      end
    end)
  end

  defp sanitize(values) when is_list(values), do: Enum.map(values, &sanitize/1)
  defp sanitize(value), do: value

  defp sensitive_key?(key) do
    text = key |> to_string() |> String.downcase()
    Enum.any?(@sensitive_key_fragments, &String.contains?(text, &1))
  end

  defp normalize_keys(%{} = map) do
    Map.new(map, fn {key, value} -> {to_string(key), normalize_keys(value)} end)
  end

  defp normalize_keys(values) when is_list(values), do: Enum.map(values, &normalize_keys/1)
  defp normalize_keys(value), do: value

  defp stringify_keys(%{} = map), do: Map.new(map, fn {key, value} -> {to_string(key), stringify_keys(value)} end)
  defp stringify_keys(values) when is_list(values), do: Enum.map(values, &stringify_keys/1)
  defp stringify_keys(value), do: value

  defp normalize_status(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize_status(value) when is_binary(value) and value != "", do: value
  defp normalize_status(_value), do: nil

  defp truthy?(value), do: value in [true, "true", 1, "1", "online", "connected"]
  defp blank_to_nil(value) when value in [nil, ""], do: nil
  defp blank_to_nil(value), do: value

  defp drop_nil_values(map), do: map |> Enum.reject(fn {_key, value} -> is_nil(value) end) |> Map.new()
  defp drop_blank_values(map), do: map |> Enum.reject(fn {_key, value} -> value in [nil, ""] end) |> Map.new()
end
