defmodule SymphonyElixir.Launcher.GatewayConfig.Database do
  @moduledoc """
  Supabase/PostgREST-backed `gateway_config` adapter.

  Configuration is read from `Application.get_env(:symphony_elixir, :launcher_gateway_config, ...)`
  and falls back to the shared `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` environment
  variables used by the rest of the launcher.

      config :symphony_elixir, :launcher_gateway_config,
        endpoint: "https://xyz.supabase.co/rest/v1",
        api_key: System.get_env("SUPABASE_SERVICE_ROLE_KEY"),
        table: "gateway_config",
        state_table: "gateway_config_state"

  When no Supabase URL or API key is configured the adapter returns
  `{:error, :not_configured}` so the launcher can fall back to the local template
  during local development without raising.
  """

  @behaviour SymphonyElixir.Launcher.GatewayConfig

  alias SymphonyElixir.Launcher.GatewayConfig.Resolved
  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.Supabase
  alias SymphonyElixir.SupabaseSchema
  alias SymphonyElixir.Time, as: Timestamp

  @impl true
  def fetch(scope_type, scope_id)
      when is_binary(scope_type) and is_binary(scope_id) and scope_type != "" and scope_id != "" do
    case config() do
      {:ok, config} ->
        do_fetch(config, scope_type, scope_id)

      {:error, :not_configured} = not_configured ->
        not_configured
    end
  end

  def fetch(_scope_type, _scope_id), do: {:error, :invalid_scope}

  @impl true
  def record_apply_state(scope_type, scope_id, status, opts)
      when is_binary(scope_type) and is_binary(scope_id) and status in [:ok, :error] do
    case config() do
      {:ok, config} ->
        do_record_apply_state(config, scope_type, scope_id, status, opts)

      {:error, :not_configured} ->
        :ok
    end
  end

  @doc false
  def req_options,
    do: Application.get_env(:symphony_elixir, :launcher_gateway_config_req_options, [])

  defp do_fetch(config, scope_type, scope_id) do
    query = %{
      "select" => SupabaseSchema.select_columns!("gateway_config"),
      "scope_type" => "eq.#{scope_type}",
      "scope_id" => "eq.#{scope_id}",
      "limit" => "1"
    }

    case PostgRESTClient.get(client(config), config.table, query,
           log_metadata: %{
             caller: "launcher.gateway_config.fetch",
             action: "launcher.gateway_config.fetch",
             table: config.table,
             scope_type: scope_type,
             scope_id: scope_id
           }
         ) do
      {:ok, [row]} ->
        with :ok <- SupabaseSchema.validate_row("gateway_config", row) do
          {:ok, row_to_resolved(row)}
        end

      {:ok, []} ->
        {:error, :not_found}

      {:ok, _rows} ->
        {:error, :invalid_response}

      {:error, _reason} = error ->
        error
    end
  end

  defp do_record_apply_state(config, scope_type, scope_id, status, opts) do
    applied_at =
      opts
      |> Keyword.get(:last_apply_at, Timestamp.now())
      |> Timestamp.to_iso8601()

    body =
      %{
        "scope_type" => scope_type,
        "scope_id" => scope_id,
        "last_apply_status" => Atom.to_string(status),
        "last_apply_at" => applied_at
      }
      |> maybe_put("last_applied_hash", Keyword.get(opts, :last_applied_hash))
      |> maybe_put("last_applied_version", Keyword.get(opts, :last_applied_version))
      |> maybe_put("broker_instance_id", Keyword.get(opts, :broker_instance_id))
      |> maybe_put("last_apply_error", Keyword.get(opts, :last_apply_error))

    case PostgRESTClient.upsert(client(config), config.state_table, body, ["scope_type", "scope_id"],
           log_metadata: %{
             caller: "launcher.gateway_config.record_apply_state",
             action: "launcher.gateway_config.record_apply_state",
             table: config.state_table,
             scope_type: scope_type,
             scope_id: scope_id,
             last_apply_status: Atom.to_string(status)
           }
         ) do
      {:ok, _body} -> :ok
      {:error, _reason} = error -> error
    end
  end

  defp row_to_resolved(row) do
    %Resolved{
      scope_type: Map.get(row, "scope_type"),
      scope_id: Map.get(row, "scope_id"),
      config_json: map_field(row, "config_json"),
      config_hash: Map.get(row, "config_hash"),
      version: Map.get(row, "version")
    }
  end

  defp map_field(row, key) do
    case Map.get(row, key) do
      value when is_map(value) -> value
      _ -> %{}
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp config do
    raw =
      Application.get_env(:symphony_elixir, :launcher_gateway_config, [])
      |> Enum.into(%{})
      |> Map.put_new(:table, "gateway_config")
      |> Map.put_new(:state_table, "gateway_config_state")

    try do
      {:ok, Supabase.merge_connection!(raw)}
    rescue
      ArgumentError -> {:error, :not_configured}
    end
  end

  defp client(config), do: PostgRESTClient.new(config, req_options())
end
