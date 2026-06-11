defmodule SymphonyElixir.Cutover.Cooldown do
  @moduledoc """
  ETS-backed cooldown tracker for provider credentials.

  Cooldowns are intentionally in-memory and keyed by `{workspace_id,
  credential_id}`. They prevent a single orchestrator instance from retrying a
  credential that just produced a persistent rate-limit signal.
  """

  use GenServer

  @table :symphony_cutover_cooldowns
  @default_ttl_ms 60_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @spec put(String.t(), String.t(), keyword()) :: :ok
  def put(workspace_id, credential_id, opts \\ [])
      when is_binary(workspace_id) and is_binary(credential_id) do
    call_or_direct({:put, workspace_id, credential_id, opts})
  end

  @spec active?(String.t(), String.t()) :: boolean()
  def active?(workspace_id, credential_id)
      when is_binary(workspace_id) and is_binary(credential_id) do
    call_or_direct({:active?, workspace_id, credential_id})
  end

  @spec clear() :: :ok
  def clear do
    call_or_direct(:clear)
  end

  @impl true
  def init(_opts) do
    ensure_table!()
    {:ok, %{}}
  end

  @impl true
  def handle_call({:put, workspace_id, credential_id, opts}, _from, state) do
    {:reply, put_direct(workspace_id, credential_id, opts), state}
  end

  @impl true
  def handle_call({:active?, workspace_id, credential_id}, _from, state) do
    {:reply, active_direct?(workspace_id, credential_id), state}
  end

  @impl true
  def handle_call(:clear, _from, state) do
    ensure_table!()
    :ets.delete_all_objects(@table)
    {:reply, :ok, state}
  end

  defp call_or_direct(message) do
    case Process.whereis(__MODULE__) do
      nil -> direct(message)
      pid -> GenServer.call(pid, message)
    end
  end

  defp direct({:put, workspace_id, credential_id, opts}), do: put_direct(workspace_id, credential_id, opts)
  defp direct({:active?, workspace_id, credential_id}), do: active_direct?(workspace_id, credential_id)

  defp direct(:clear) do
    ensure_table!()
    :ets.delete_all_objects(@table)
    :ok
  end

  defp put_direct(workspace_id, credential_id, opts) do
    ensure_table!()
    ttl_ms = Keyword.get(opts, :ttl_ms, configured_ttl_ms())
    expires_at = monotonic_ms() + ttl_ms
    true = :ets.insert(@table, {{workspace_id, credential_id}, expires_at})
    :ok
  end

  defp active_direct?(workspace_id, credential_id) do
    ensure_table!()

    case :ets.lookup(@table, {workspace_id, credential_id}) do
      [{{^workspace_id, ^credential_id}, expires_at}] ->
        if expires_at > monotonic_ms() do
          true
        else
          :ets.delete(@table, {workspace_id, credential_id})
          false
        end

      [] ->
        false
    end
  end

  defp ensure_table! do
    case :ets.whereis(@table) do
      :undefined ->
        :ets.new(@table, [:set, :protected, :named_table, read_concurrency: true])

      _tid ->
        @table
    end
  end

  defp configured_ttl_ms do
    Application.get_env(:symphony_elixir, :cutover_cooldown_ttl_ms, @default_ttl_ms)
  end

  defp monotonic_ms, do: System.monotonic_time(:millisecond)
end
