defmodule SymphonyElixir.Launcher.EngineInstance do
  @moduledoc """
  Supabase/PostgREST client for the `engine_instance` table.

  The launcher writes the full lifecycle state (start, stop, crash, restart,
  heartbeat) of each orchestrator process into this table so the platform
  can discover host/port/status without querying launcher in-memory state.

  ## Configuration

  Writeback is gated on two environment variables:

  - `LAUNCHER_SUPABASE_URL` — PostgREST endpoint, e.g. `https://xyz.supabase.co/rest/v1`
  - `LAUNCHER_SUPABASE_SERVICE_KEY` — service-role API key

  When either is absent (local dev) writeback is disabled and every function
  returns `:disabled`. This matches the boundary described in
  [../docs/db_agent_inventory.md](../docs/db_agent_inventory.md).

  Optional overrides (for tests / ops pinning):

      config :symphony_elixir, :launcher_engine_instance,
        endpoint: "...",
        api_key: "...",
        table: "engine_instance",
        host: "orchestrator-1.internal"

  Tests can inject a `Req.Test` plug via:

      config :symphony_elixir, :launcher_engine_instance_req_options, plug: {Req.Test, SomeStub}

  The `host` field identifies the launcher process; on boot, the launcher
  queries rows with `host=<my host>` to reconcile stale rows from a previous
  launcher incarnation.
  """

  require Logger
  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.Supabase
  alias SymphonyElixir.Time, as: Timestamp

  @table "engine_instance"
  @default_role "unified"
  @stale_replace_statuses ["failed", "unhealthy"]

  @type status :: :starting | :restarting | :running | :healthy | :unhealthy | :failed | :draining | :stopped

  @doc """
  Whether writeback is enabled in the current environment.

  Returns `true` only when both `LAUNCHER_SUPABASE_URL` and
  `LAUNCHER_SUPABASE_SERVICE_KEY` resolve to non-empty strings (via env vars
  or the `:launcher_engine_instance` config override).
  """
  @spec enabled?() :: boolean()
  def enabled? do
    case resolve_config() do
      {:ok, _config} -> true
      _ -> false
    end
  end

  @doc """
  Host identifier written into `engine_instance.host` for rows owned by
  this launcher.

  Resolution order:

    1. `:host` key from the `:launcher_engine_instance` app config
    2. `LAUNCHER_HOST` environment variable
    3. the machine's hostname via `:inet.gethostname/0`
    4. `"127.0.0.1"` as a last resort

  Boot-time reconcile queries `engine_instance WHERE host=<this value>`,
  so the default must be node-unique — loopback is only used when the
  machine has no hostname at all (very rare). In multi-node deployments
  ops should always set `LAUNCHER_HOST` to a routable identifier.
  """
  @spec host() :: String.t()
  def host do
    Map.get(base_config(), :host) || system_env("LAUNCHER_HOST") || gethostname() || "127.0.0.1"
  end

  defp gethostname do
    case :inet.gethostname() do
      {:ok, charlist} when charlist != [] -> List.to_string(charlist)
      _ -> nil
    end
  end

  @doc """
  Insert (or upsert) a row for a freshly-started orchestrator.

  The attrs map must contain `:instance_id`, `:agent_id`, `:workspace_id`,
  `:port`. `:role` defaults to `"unified"`, `:status` defaults to
  `"running"`, and `:started_at` defaults to the current UTC time.
  """
  @spec upsert(map()) :: :ok | :disabled | {:error, term()}
  def upsert(%{} = attrs) do
    with {:ok, config} <- resolve_config(),
         {:ok, row} <- build_row(attrs, config) do
      upsert_active_row(config, row)
    end
  end

  @doc """
  Update `status` (and touch `updated_at`) for an existing row.
  """
  @spec update_status(String.t(), status()) :: :ok | :disabled | {:error, term()}
  def update_status(instance_id, status) when is_binary(instance_id) do
    patch(
      instance_id,
      %{
        "status" => to_string(status),
        "updated_at" => Timestamp.now_iso8601()
      },
      "launcher.engine_instance.update_status"
    )
  end

  @doc """
  Update `last_health_at` (and touch `updated_at`) for the running row.
  """
  @spec heartbeat(String.t()) :: :ok | :disabled | {:error, term()}
  def heartbeat(instance_id) when is_binary(instance_id) do
    now = Timestamp.now_iso8601()
    patch(instance_id, %{"last_health_at" => now, "updated_at" => now}, "launcher.engine_instance.heartbeat")
  end

  @doc """
  Fetch all rows for a given host. Used by the launcher on boot to
  reconcile state against what this host previously persisted.
  """
  @spec list_by_host(String.t()) :: {:ok, [map()]} | :disabled | {:error, term()}
  def list_by_host(host) when is_binary(host) do
    case resolve_config() do
      {:ok, config} ->
        case PostgRESTClient.get(client(config), config.table, %{"host" => "eq.#{host}"},
               log_metadata:
                 log_metadata("launcher.engine_instance.list_by_host", config.table,
                   host: host
                 )
             ) do
          {:ok, body} when is_list(body) -> {:ok, body}
          {:ok, body} -> {:error, {:invalid_response, body}}
          {:error, _reason} = error -> error
        end

      :disabled ->
        :disabled
    end
  end

  # --- Private ---

  defp patch(instance_id, payload, caller) do
    with {:ok, config} <- resolve_config() do
      config
      |> client()
      |> PostgRESTClient.patch(config.table, %{"instance_id" => "eq.#{instance_id}"}, payload,
        prefer: "return=minimal",
        log_metadata:
          log_metadata(caller, config.table,
            instance_id: instance_id,
            status: Map.get(payload, "status")
          )
      )
      |> ok_result()
    end
  end

  defp upsert_active_row(config, row) do
    case replace_active_row(config, row) do
      :replaced ->
        :ok

      :not_found ->
        case insert_instance_row(config, row) do
          {:error, {:http_error, 409, _body}} ->
            case replace_active_row(config, row) do
              :replaced -> :ok
              :not_found -> {:error, {:active_row_conflict, row["agent_id"]}}
              {:error, _reason} = error -> error
            end

          result ->
            result
        end

      {:error, _reason} = error ->
        error
    end
  end

  defp replace_active_row(config, row) do
    query = %{
      "workspace_id" => "eq.#{row["workspace_id"]}",
      "agent_id" => "eq.#{row["agent_id"]}",
      "role" => "eq.#{row["role"]}",
      "status" => "in.(#{Enum.join(@stale_replace_statuses, ",")})"
    }

    case PostgRESTClient.patch(client(config), config.table, query, row,
           prefer: "return=representation",
           log_metadata:
             log_metadata("launcher.engine_instance.replace_active_row", config.table,
               instance_id: row["instance_id"],
               agent_id: row["agent_id"],
               workspace_id: row["workspace_id"]
             )
         ) do
      {:ok, [_ | _]} -> :replaced
      {:ok, []} -> :not_found
      {:ok, _body} -> :not_found
      {:error, _reason} = error -> error
    end
  end

  defp insert_instance_row(config, row) do
    # on_conflict=instance_id keeps repeated writes for the same launcher id
    # idempotent. Active-row replacement above handles stale rows with a
    # different instance_id but the same workspace/agent/role.
    config
    |> client()
    |> PostgRESTClient.upsert(config.table, row, "instance_id",
      prefer: "return=minimal,resolution=merge-duplicates",
      log_metadata:
        log_metadata("launcher.engine_instance.upsert", config.table,
          instance_id: row["instance_id"],
          agent_id: row["agent_id"],
          workspace_id: row["workspace_id"],
          status: row["status"]
        )
    )
    |> ok_result()
  end

  defp build_row(attrs, config) do
    with {:ok, instance_id} <- fetch_required(attrs, :instance_id),
         {:ok, agent_id} <- fetch_required(attrs, :agent_id),
         {:ok, workspace_id} <- fetch_required(attrs, :workspace_id),
         {:ok, port} <- fetch_required(attrs, :port) do
      row =
        %{
          "instance_id" => instance_id,
          "agent_id" => agent_id,
          "workspace_id" => workspace_id,
          "host" => Map.get(attrs, :host) || config.host,
          "port" => port,
          "role" => Map.get(attrs, :role) || @default_role,
          "status" => status_string(Map.get(attrs, :status) || :running),
          "started_at" => Timestamp.to_iso8601(Map.get(attrs, :started_at)) || Timestamp.now_iso8601(),
          "updated_at" => Timestamp.now_iso8601()
        }
        |> maybe_put("last_health_at", Timestamp.to_iso8601(Map.get(attrs, :last_health_at)))
        |> maybe_put("ws_connection_id", Map.get(attrs, :ws_connection_id))

      {:ok, row}
    end
  end

  defp fetch_required(attrs, key) do
    case Map.get(attrs, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      value when is_integer(value) -> {:ok, value}
      _ -> {:error, {:missing_field, key}}
    end
  end

  defp status_string(value) when is_atom(value), do: Atom.to_string(value)
  defp status_string(value) when is_binary(value), do: value

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  @doc false
  def req_options do
    Application.get_env(:symphony_elixir, :launcher_engine_instance_req_options, [])
  end

  defp base_config do
    Application.get_env(:symphony_elixir, :launcher_engine_instance, [])
    |> Enum.into(%{})
  end

  defp resolve_config do
    base = base_config()

    connection_opts =
      base
      |> Map.update(:endpoint, system_env("LAUNCHER_SUPABASE_URL"), fn value -> value end)
      |> Map.update(:api_key, system_env("LAUNCHER_SUPABASE_SERVICE_KEY"), fn value -> value end)

    try do
      merged = Supabase.merge_connection!(connection_opts)

      {:ok,
       %{
         endpoint: merged.endpoint,
         api_key: merged.api_key,
         table: Map.get(base, :table, @table),
         host: Map.get(base, :host) || system_env("LAUNCHER_HOST") || gethostname() || "127.0.0.1"
       }}
    rescue
      ArgumentError -> :disabled
    end
  end

  defp client(config), do: PostgRESTClient.new(config, req_options())

  defp ok_result({:ok, _body}), do: :ok
  defp ok_result({:error, _reason} = error), do: error

  defp log_metadata(caller, table, extra) do
    extra
    |> Map.new()
    |> Map.merge(%{caller: caller, action: caller, table: table})
    |> Map.reject(fn {_key, value} -> value in [nil, ""] end)
  end

  defp system_env(name) do
    case System.get_env(name) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end
end
