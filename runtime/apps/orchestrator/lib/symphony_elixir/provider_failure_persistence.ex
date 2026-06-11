defmodule SymphonyElixir.ProviderFailurePersistence do
  @moduledoc """
  Best-effort persistence for typed provider failure events.

  Runtime logs remain the immediate observability channel. This writer feeds the
  slower router-agent loop and must never make a provider failure worse.
  """

  alias SymphonyElixir.{PostgRESTClient, RuntimeLog, Supabase}

  @table "provider_failure"
  @required_fields [:workspace_id, :runner_kind, :provider, :model, :error_code]

  @spec write(map()) :: :ok
  def write(classification) when is_map(classification) do
    with {:ok, payload} <- payload_from(classification),
         {:ok, config} <- connection_config(),
         {:ok, _body} <-
           PostgRESTClient.post(client(config), @table, payload,
             prefer: "return=minimal",
             log_metadata: %{caller: "provider_failure_persistence.write", table: @table}
           ) do
      :ok
    else
      {:skip, reason} ->
        RuntimeLog.log(:warning, :provider_failure_persistence_skipped, %{
          error_code: "provider_failure_missing_fields",
          reason: inspect(reason)
        })

      {:error, reason} ->
        RuntimeLog.log(:warning, :provider_failure_persistence_failed, %{
          error_code: "provider_failure_write_failed",
          retryable: true,
          reason: inspect(reason)
        })
    end

    :ok
  end

  def write(_classification), do: :ok

  defp payload_from(classification) do
    if Enum.all?(@required_fields, &present?(classification, &1)) do
      {:ok,
       %{
         "workspace_id" => field(classification, :workspace_id),
         "agent_id" => field(classification, :agent_id),
         "work_item_id" => field(classification, :work_item_id),
         "run_id" => field(classification, :run_id),
         "runner_kind" => field(classification, :runner_kind),
         "provider" => field(classification, :provider),
         "model" => field(classification, :model),
         "error_code" => field(classification, :error_code),
         "status_code" => field(classification, :status_code),
         "attempt" => attempt(field(classification, :attempt))
       }
       |> reject_nil_values()}
    else
      missing =
        @required_fields
        |> Enum.reject(&present?(classification, &1))
        |> Enum.map(&Atom.to_string/1)

      {:skip, {:missing_required_fields, missing}}
    end
  end

  defp connection_config do
    with {:ok, endpoint} <- Supabase.rest_endpoint(),
         {:ok, api_key} <- Supabase.service_role_key() do
      {:ok, %{endpoint: endpoint, api_key: api_key}}
    else
      {:error, reason} -> {:error, {:supabase_config, reason}}
    end
  end

  defp client(config) do
    PostgRESTClient.new(config, Application.get_env(:symphony_elixir, :provider_failure_persistence_req_options, []))
  end

  defp present?(map, key) do
    case field(map, key) do
      value when is_binary(value) -> String.trim(value) != ""
      nil -> false
      _value -> true
    end
  end

  defp field(map, key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))

  defp attempt(value) when is_integer(value) and value >= 1, do: value
  defp attempt(_value), do: 1

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end
end
