defmodule SymphonyElixir.Cutover.Cooldown do
  @moduledoc """
  In-memory cooldowns for provider credentials that recently rate-limited.
  """

  @table :symphony_cutover_cooldowns
  @default_ttl_ms 60_000

  @spec active?(String.t() | nil, String.t() | nil) :: boolean()
  def active?(_workspace_id, nil), do: false
  def active?(nil, _credential_id), do: false

  def active?(workspace_id, credential_id) do
    ensure_table!()
    now = now_ms()

    case :ets.lookup(@table, {workspace_id, credential_id}) do
      [{{^workspace_id, ^credential_id}, expires_at}] when expires_at > now ->
        true

      [{{^workspace_id, ^credential_id}, _expires_at}] ->
        :ets.delete(@table, {workspace_id, credential_id})
        false

      [] ->
        false
    end
  end

  @spec put(String.t() | nil, String.t() | nil) :: :ok
  def put(workspace_id, credential_id), do: put(workspace_id, credential_id, @default_ttl_ms)

  @spec put(String.t() | nil, String.t() | nil, non_neg_integer()) :: :ok
  def put(_workspace_id, nil, _ttl_ms), do: :ok
  def put(nil, _credential_id, _ttl_ms), do: :ok

  def put(workspace_id, credential_id, ttl_ms) when is_integer(ttl_ms) and ttl_ms >= 0 do
    ensure_table!()
    :ets.insert(@table, {{workspace_id, credential_id}, now_ms() + ttl_ms})
    :ok
  end

  @spec clear() :: :ok
  def clear do
    ensure_table!()
    :ets.delete_all_objects(@table)
    :ok
  end

  defp ensure_table! do
    case :ets.info(@table) do
      :undefined -> :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
      _info -> @table
    end
  end

  defp now_ms, do: System.monotonic_time(:millisecond)
end
