defmodule SymphonyElixir.LocalRelay.TokenValidator.PostgREST do
  @moduledoc """
  Token validator backed by Supabase tables through `PostgRESTClient`.

  Production runs in launcher escript mode, which does NOT start
  `SymphonyElixir.Repo` (Repo only starts when `SUPABASE_POOLER` is
  configured). The previous Ecto-based adapter therefore crashed on every
  helper connection with `"could not lookup Ecto repo SymphonyElixir.Repo"`,
  which `TokenValidator.validate/2` surfaced as `:validator_unavailable` —
  rejecting every relay connection even with a valid token. This adapter
  brings token validation in line with the "always PostgREST in the launcher
  path" convention (see CLAUDE.md "Database Connection Conventions").

  The validator hashes the presented token, embeds `local_runtime_machine`
  via an inner join, rejects revoked tokens or machines, returns the
  workspace/machine metadata used by relay presence, and records successful
  use on `local_runtime_token.last_used_at`.
  """

  @behaviour SymphonyElixir.LocalRelay.TokenValidator

  alias SymphonyElixir.LocalRelay.TokenValidator
  alias SymphonyElixir.{PostgRESTClient, RuntimeLog, Time}

  @token_table "local_runtime_token"
  @machine_table "local_runtime_machine"

  # Inner join: drops the token row if its machine is missing or revoked.
  @select "id,#{@machine_table}!inner(id,workspace_id,runner_kinds)"

  @impl true
  def validate(token, attrs) when is_binary(token) and is_map(attrs) do
    token_hash = TokenValidator.hash_token(token)

    with {:ok, metadata} <- fetch_metadata(token_hash),
         :ok <- match_attr(metadata, attrs, :workspace_id, :workspace_mismatch),
         :ok <- match_attr(metadata, attrs, :machine_id, :machine_mismatch) do
      touch_last_used(metadata.token_id)
      {:ok, metadata}
    end
  end

  defp fetch_metadata(token_hash) do
    query = %{
      "select" => @select,
      "token_hash" => "eq.#{token_hash}",
      "revoked_at" => "is.null",
      "#{@machine_table}.revoked_at" => "is.null",
      "limit" => "1"
    }

    with {:ok, client} <- client(),
         {:ok, rows} when is_list(rows) <-
           PostgRESTClient.get(client, @token_table, query,
             log_metadata: %{operation: "local_relay.token_validate", table: @token_table}
           ) do
      case rows do
        [] ->
          log_failure(:invalid_token, %{})
          {:error, :invalid_token}

        [row | _] ->
          {:ok, normalize_metadata(row)}
      end
    else
      {:ok, body} ->
        log_failure(:validator_unavailable, %{reason: "unexpected_response", body: inspect(body)})
        {:error, :validator_unavailable}

      {:error, reason} ->
        log_failure(:validator_unavailable, %{reason: inspect(reason)})
        {:error, :validator_unavailable}
    end
  end

  defp normalize_metadata(row) when is_map(row) do
    machine = row["local_runtime_machine"] || %{}

    %{
      workspace_id: machine["workspace_id"],
      machine_id: machine["id"],
      token_id: row["id"],
      runner_kinds: normalize_runner_kinds(machine["runner_kinds"]),
      revoked?: false
    }
  end

  defp normalize_runner_kinds(runner_kinds) when is_list(runner_kinds) do
    Enum.filter(runner_kinds, &is_binary/1)
  end

  defp normalize_runner_kinds(_runner_kinds), do: []

  defp match_attr(metadata, attrs, key, reason) do
    expected = Map.get(metadata, key)
    actual = Map.get(attrs, key)

    cond do
      not is_binary(expected) or expected == "" ->
        :ok

      not is_binary(actual) or actual == "" ->
        :ok

      expected == actual ->
        :ok

      true ->
        log_failure(reason, %{token_id: metadata.token_id, expected: expected, actual: actual})
        {:error, reason}
    end
  end

  defp touch_last_used(nil), do: :ok

  defp touch_last_used(token_id) when is_binary(token_id) do
    case touch_mode() do
      :async ->
        Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
          do_touch_last_used(token_id)
        end)

      :sync ->
        do_touch_last_used(token_id)
    end

    :ok
  end

  defp do_touch_last_used(token_id) do
    with {:ok, client} <- client(),
         {:ok, _body} <-
           PostgRESTClient.patch(client, @token_table, %{"id" => "eq.#{token_id}"},
             %{"last_used_at" => Time.now_iso8601()},
             prefer: "return=minimal",
             log_metadata: %{operation: "local_relay.token_touch_last_used", table: @token_table}
           ) do
      :ok
    else
      {:error, reason} ->
        log_touch_failure(token_id, inspect(reason))
        :ok
    end
  rescue
    error -> log_touch_failure(token_id, Exception.message(error))
  catch
    :exit, reason -> log_touch_failure(token_id, inspect(reason))
  end

  defp log_touch_failure(token_id, reason) do
    RuntimeLog.log(:warning, :local_relay_token_last_used_at_update_failed, %{
      token_id: token_id,
      reason: reason
    })

    :ok
  end

  defp log_failure(reason, fields) do
    RuntimeLog.log(
      :warning,
      :local_relay_token_validation_failed,
      Map.put(fields, :reason, reason)
    )
  end

  defp client do
    config =
      Application.get_env(:symphony_elixir, __MODULE__, [])
      |> normalize_config()

    {:ok, PostgRESTClient.new(config, req_options())}
  rescue
    error in ArgumentError -> {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp normalize_config(nil), do: %{}
  defp normalize_config(config) when is_list(config), do: Map.new(config)
  defp normalize_config(config) when is_map(config), do: config

  defp req_options do
    Application.get_env(:symphony_elixir, :local_relay_token_validator_req_options, [])
  end

  defp touch_mode do
    Application.get_env(:symphony_elixir, :local_relay_token_validator_db_touch_mode, :async)
  end
end
