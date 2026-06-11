defmodule SymphonyElixir.Cutover.Audit do
  @moduledoc """
  Best-effort writer for provider cutover audit rows.

  The platform owns the `provider_cutover` table and validates workspace
  scope through `POST /api/work-items/:id/cutovers`.
  """

  alias SymphonyElixir.Cutover.Decision
  alias SymphonyElixir.{MapUtils, RuntimeLog}

  @type write_result :: :ok | {:error, term()}

  @spec write(Decision.t() | map(), keyword()) :: write_result()
  def write(decision, opts \\ [])

  def write(%Decision{} = decision, opts) do
    with {:ok, work_item_id} <- work_item_id(decision),
         {:ok, config} <- config(opts) do
      payload = payload(decision)

      req =
        [headers: headers(config)]
        |> Keyword.merge(config.req_options)
        |> Req.new()

      case Req.post(req, url: url(config.endpoint, work_item_id), json: payload) do
        {:ok, %Req.Response{status: status}} when status in 200..299 ->
          :ok

        {:ok, %Req.Response{status: status, body: body}} ->
          {:error, {:platform_cutover_http_error, status, body}}

        {:error, reason} ->
          {:error, {:platform_cutover_request_failed, reason}}
      end
    end
  end

  def write(%{} = decision, opts), do: decision |> struct_from_map() |> write(opts)

  @spec write_best_effort(Decision.t() | map(), keyword()) :: :ok
  def write_best_effort(decision, opts \\ []) do
    case write(decision, opts) do
      :ok ->
        :ok

      {:error, reason} ->
        log_failure(decision, reason)
    end
  end

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :cutover_audit_req_options, [])

  @doc false
  def payload(%Decision{} = decision) do
    %{
      "workspaceId" => decision.workspace_id,
      "agentId" => decision.agent_id,
      "fromProvider" => decision.from_provider,
      "fromModel" => decision.from_model,
      "fromCredentialId" => decision.from_credential_id,
      "toProvider" => decision.to_provider,
      "toModel" => decision.to_model,
      "toCredentialId" => decision.to_credential_id,
      "triggerErrorCode" => decision.trigger_error_code,
      "triggerStatusCode" => decision.trigger_status_code,
      "elapsedMs" => decision.elapsed_ms,
      "outcome" => outcome(decision.outcome)
    }
    |> maybe_put("triggeredAt", iso8601(decision.triggered_at))
    |> MapUtils.drop_nil_values()
  end

  defp config(opts) do
    audit_config =
      :symphony_elixir
      |> Application.get_env(:cutover_audit, [])
      |> Enum.into(%{})

    control_plane_config =
      :symphony_elixir
      |> Application.get_env(:agent_control_plane, [])
      |> Enum.into(%{})

    raw =
      control_plane_config
      |> Map.merge(audit_config)
      |> Map.merge(Map.new(Keyword.get(opts, :cutover_audit_config, [])))

    endpoint =
      string_config(raw, :endpoint) ||
        string_config(raw, "endpoint") ||
        env_config("PLATFORM_API_ENDPOINT")

    api_key =
      string_config(raw, :api_key) ||
        string_config(raw, "api_key") ||
        env_config("PLATFORM_API_KEY")

    req_options = Keyword.get(opts, :req_options, req_options())

    case endpoint do
      value when is_binary(value) and value != "" ->
        {:ok,
         %{
           endpoint: String.trim_trailing(value, "/"),
           api_key: api_key,
           req_options: req_options
         }}

      _ ->
        {:error, :missing_cutover_audit_endpoint}
    end
  end

  defp work_item_id(%Decision{work_item_id: value}) when is_binary(value) and value != "",
    do: {:ok, value}

  defp work_item_id(_decision), do: {:error, :missing_cutover_work_item_id}

  defp headers(%{api_key: api_key}) when is_binary(api_key) and api_key != "" do
    [
      {"accept", "application/json"},
      {"content-type", "application/json"},
      {"authorization", "Bearer #{api_key}"}
    ]
  end

  defp headers(_config), do: [{"accept", "application/json"}, {"content-type", "application/json"}]

  defp url(endpoint, work_item_id) do
    encoded_work_item_id = URI.encode(work_item_id, &URI.char_unreserved?/1)
    endpoint <> "/api/work-items/" <> encoded_work_item_id <> "/cutovers"
  end

  defp log_failure(decision, reason) do
    fields =
      decision
      |> log_fields()
      |> Map.merge(%{
        error_code: "cutover_audit_persistence_failed",
        reason: inspect(reason),
        retryable: retryable?(reason),
        non_fatal: true
      })

    RuntimeLog.log(:error, :cutover_audit_persistence_failed, fields)
  end

  defp log_fields(%Decision{} = decision) do
    %{
      workspace_id: decision.workspace_id,
      agent_id: decision.agent_id,
      work_item_id: decision.work_item_id,
      from_provider: decision.from_provider,
      from_model: decision.from_model,
      to_provider: decision.to_provider,
      to_model: decision.to_model,
      outcome: outcome(decision.outcome)
    }
    |> MapUtils.drop_nil_values()
  end

  defp log_fields(%{} = decision), do: log_fields(struct_from_map(decision))
  defp log_fields(_decision), do: %{}

  defp retryable?({:platform_cutover_http_error, status, _body}) when status in 500..599, do: true
  defp retryable?({:platform_cutover_request_failed, _reason}), do: true
  defp retryable?(_reason), do: false

  defp struct_from_map(map) do
    %Decision{
      workspace_id: get_value(map, :workspace_id, "workspace_id", "workspaceId"),
      agent_id: get_value(map, :agent_id, "agent_id", "agentId"),
      work_item_id: get_value(map, :work_item_id, "work_item_id", "workItemId"),
      from_provider: get_value(map, :from_provider, "from_provider", "fromProvider"),
      from_model: get_value(map, :from_model, "from_model", "fromModel"),
      from_credential_id: get_value(map, :from_credential_id, "from_credential_id", "fromCredentialId"),
      to_provider: get_value(map, :to_provider, "to_provider", "toProvider"),
      to_model: get_value(map, :to_model, "to_model", "toModel"),
      to_credential_id: get_value(map, :to_credential_id, "to_credential_id", "toCredentialId"),
      trigger_error_code: get_value(map, :trigger_error_code, "trigger_error_code", "triggerErrorCode"),
      trigger_status_code: get_value(map, :trigger_status_code, "trigger_status_code", "triggerStatusCode"),
      elapsed_ms: get_value(map, :elapsed_ms, "elapsed_ms", "elapsedMs") || 0,
      outcome: get_value(map, :outcome, "outcome"),
      triggered_at: get_value(map, :triggered_at, "triggered_at", "triggeredAt"),
      attempts: get_value(map, :attempts, "attempts") || []
    }
  end

  defp get_value(map, keys), do: Enum.find_value(keys, &Map.get(map, &1))
  defp get_value(map, key1, key2), do: get_value(map, [key1, key2])
  defp get_value(map, key1, key2, key3), do: get_value(map, [key1, key2, key3])

  defp string_config(map, key) do
    case Map.get(map, key) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp env_config(name) do
    case System.get_env(name) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp iso8601(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp iso8601(value) when is_binary(value) and value != "", do: value
  defp iso8601(_value), do: nil

  defp outcome(value) when is_atom(value), do: Atom.to_string(value)
  defp outcome(value) when is_binary(value), do: value
end
