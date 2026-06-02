defmodule SymphonyElixir.RuntimeLease.Registry do
  @moduledoc """
  In-memory runtime lease metadata registry.

  The registry records cloud-neutral run, session, cache, and task leases so
  cleanup code can make deterministic decisions before durable DB-backed lease
  storage is available.
  """

  use GenServer

  require Logger

  @terminal_statuses ~w(released stale orphaned)

  defmodule Lease do
    @moduledoc false

    @enforce_keys [:id, :kind, :inserted_at, :updated_at]
    defstruct [
      :id,
      :kind,
      :owner,
      :workspace_id,
      :agent_id,
      :run_id,
      :session_id,
      :task_ref,
      :workspace_path,
      :status,
      :heartbeat_at,
      :idle_expires_at,
      :max_expires_at,
      :lease_expires_at,
      :released_at,
      :inserted_at,
      :updated_at,
      materialized_grant_versions: %{},
      metadata: %{}
    ]

    @type t :: %__MODULE__{
            id: String.t(),
            kind: String.t(),
            owner: String.t() | nil,
            workspace_id: String.t() | nil,
            agent_id: String.t() | nil,
            run_id: String.t() | nil,
            session_id: String.t() | nil,
            task_ref: String.t() | nil,
            workspace_path: Path.t() | nil,
            status: String.t() | nil,
            heartbeat_at: DateTime.t() | nil,
            idle_expires_at: DateTime.t() | nil,
            max_expires_at: DateTime.t() | nil,
            lease_expires_at: DateTime.t() | nil,
            released_at: DateTime.t() | nil,
            inserted_at: DateTime.t(),
            updated_at: DateTime.t(),
            materialized_grant_versions: map(),
            metadata: map()
          }
  end

  defmodule State do
    @moduledoc false

    @enforce_keys [:leases]
    defstruct [:leases]

    @type t :: %__MODULE__{leases: %{optional(String.t()) => Lease.t()}}
  end

  @type server :: GenServer.server()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @spec upsert_lease(server(), map() | keyword()) :: {:ok, Lease.t()} | {:error, term()}
  def upsert_lease(server \\ __MODULE__, attrs) do
    GenServer.call(server, {:upsert_lease, normalize_attrs(Map.new(attrs)), now_from(nil)})
  end

  @spec heartbeat(server(), String.t(), keyword()) :: {:ok, Lease.t()} | {:error, term()}
  def heartbeat(server \\ __MODULE__, lease_id, opts \\ []) when is_binary(lease_id) do
    GenServer.call(server, {:heartbeat, lease_id, now_from(opts), Keyword.get(opts, :idle_timeout_ms)})
  end

  @spec release_lease(server(), String.t(), keyword()) :: {:ok, Lease.t()} | {:error, :not_found}
  def release_lease(server \\ __MODULE__, lease_id, opts \\ []) when is_binary(lease_id) do
    GenServer.call(server, {:release_lease, lease_id, now_from(opts)})
  end

  @spec get_lease(server(), String.t()) :: {:ok, Lease.t()} | :error
  def get_lease(server \\ __MODULE__, lease_id) when is_binary(lease_id) do
    GenServer.call(server, {:get_lease, lease_id})
  end

  @spec list_leases(server()) :: [Lease.t()]
  def list_leases(server \\ __MODULE__) do
    GenServer.call(server, :list_leases)
  end

  @spec reap_stale_leases(server(), keyword()) :: [Lease.t()]
  def reap_stale_leases(server \\ __MODULE__, opts \\ []) do
    GenServer.call(server, {:reap_stale_leases, now_from(opts)})
  end

  @spec mark_orphaned_tasks(server(), [String.t()], keyword()) :: [Lease.t()]
  def mark_orphaned_tasks(server \\ __MODULE__, active_task_refs, opts \\ []) when is_list(active_task_refs) do
    GenServer.call(server, {:mark_orphaned_tasks, MapSet.new(active_task_refs), now_from(opts)})
  end

  @impl true
  def init(_opts) do
    {:ok, %State{leases: %{}}}
  end

  @impl true
  def handle_call({:upsert_lease, attrs, now}, _from, %State{} = state) do
    with {:ok, id} <- fetch_required(attrs, :id),
         {:ok, kind} <- fetch_required(attrs, :kind) do
      lease =
        state.leases
        |> Map.get(id, new_lease(id, kind, now))
        |> merge_attrs(attrs)
        |> Map.put(:updated_at, now)
        |> Map.put_new(:status, "active")

      log_cleanup_metric("lease_upserted", lease)
      {:reply, {:ok, lease}, put_lease(state, lease)}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:heartbeat, lease_id, now, idle_timeout_ms}, _from, %State{} = state) do
    case Map.fetch(state.leases, lease_id) do
      {:ok, %Lease{status: status} = lease} when status not in @terminal_statuses ->
        heartbeat =
          lease
          |> Map.put(:heartbeat_at, now)
          |> Map.put(:updated_at, now)
          |> maybe_extend_idle_deadline(now, idle_timeout_ms)

        log_cleanup_metric("lease_heartbeat", heartbeat)
        {:reply, {:ok, heartbeat}, put_lease(state, heartbeat)}

      {:ok, %Lease{} = lease} ->
        {:reply, {:error, {:lease_terminal, lease}}, state}

      :error ->
        {:reply, {:error, :not_found}, state}
    end
  end

  def handle_call({:release_lease, lease_id, now}, _from, %State{} = state) do
    case Map.fetch(state.leases, lease_id) do
      {:ok, %Lease{} = lease} ->
        released = %{lease | status: "released", released_at: now, updated_at: now}
        log_cleanup_metric("lease_released", released)
        {:reply, {:ok, released}, put_lease(state, released)}

      :error ->
        {:reply, {:error, :not_found}, state}
    end
  end

  def handle_call({:get_lease, lease_id}, _from, %State{} = state) do
    case Map.fetch(state.leases, lease_id) do
      {:ok, lease} -> {:reply, {:ok, lease}, state}
      :error -> {:reply, :error, state}
    end
  end

  def handle_call(:list_leases, _from, %State{} = state) do
    leases =
      state.leases
      |> Map.values()
      |> Enum.sort_by(&{&1.kind, &1.id})

    {:reply, leases, state}
  end

  def handle_call({:reap_stale_leases, now}, _from, %State{} = state) do
    {state, stale_leases} = mark_stale_leases(state, now)
    Enum.each(stale_leases, &log_cleanup_metric("lease_stale", &1))
    {:reply, stale_leases, state}
  end

  def handle_call({:mark_orphaned_tasks, active_task_refs, now}, _from, %State{} = state) do
    {state, orphaned} =
      Enum.reduce(state.leases, {state, []}, fn {_id, lease}, {acc_state, acc_orphans} ->
        if orphaned_task?(lease, active_task_refs) do
          orphan = %{lease | status: "orphaned", updated_at: now}
          {put_lease(acc_state, orphan), [orphan | acc_orphans]}
        else
          {acc_state, acc_orphans}
        end
      end)

    orphaned = Enum.reverse(orphaned)
    Enum.each(orphaned, &log_cleanup_metric("task_orphaned", &1))
    {:reply, orphaned, state}
  end

  defp fetch_required(attrs, key) do
    case Map.get(attrs, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_required_lease_field, key}}
    end
  end

  defp normalize_attrs(attrs) do
    Enum.reduce(attrs, %{}, fn
      {"id", value}, acc -> Map.put(acc, :id, value)
      {"kind", value}, acc -> Map.put(acc, :kind, value)
      {"owner", value}, acc -> Map.put(acc, :owner, value)
      {"workspace_id", value}, acc -> Map.put(acc, :workspace_id, value)
      {"agent_id", value}, acc -> Map.put(acc, :agent_id, value)
      {"run_id", value}, acc -> Map.put(acc, :run_id, value)
      {"session_id", value}, acc -> Map.put(acc, :session_id, value)
      {"task_ref", value}, acc -> Map.put(acc, :task_ref, value)
      {"workspace_path", value}, acc -> Map.put(acc, :workspace_path, value)
      {"status", value}, acc -> Map.put(acc, :status, value)
      {"heartbeat_at", value}, acc -> Map.put(acc, :heartbeat_at, value)
      {"idle_expires_at", value}, acc -> Map.put(acc, :idle_expires_at, value)
      {"max_expires_at", value}, acc -> Map.put(acc, :max_expires_at, value)
      {"lease_expires_at", value}, acc -> Map.put(acc, :lease_expires_at, value)
      {"materialized_grant_versions", value}, acc -> Map.put(acc, :materialized_grant_versions, value)
      {"metadata", value}, acc -> Map.put(acc, :metadata, value)
      {key, value}, acc -> Map.put(acc, key, value)
    end)
  end

  defp merge_attrs(%Lease{} = lease, attrs) do
    allowed_fields = [
      :owner,
      :workspace_id,
      :agent_id,
      :run_id,
      :session_id,
      :task_ref,
      :workspace_path,
      :status,
      :heartbeat_at,
      :idle_expires_at,
      :max_expires_at,
      :lease_expires_at,
      :materialized_grant_versions,
      :metadata
    ]

    Enum.reduce(allowed_fields, lease, fn field, acc ->
      case Map.fetch(attrs, field) do
        {:ok, value} -> Map.put(acc, field, value)
        :error -> acc
      end
    end)
  end

  defp new_lease(id, kind, now) do
    %Lease{id: id, kind: kind, status: "active", heartbeat_at: now, inserted_at: now, updated_at: now}
  end

  defp put_lease(%State{} = state, %Lease{} = lease) do
    %{state | leases: Map.put(state.leases, lease.id, lease)}
  end

  defp maybe_extend_idle_deadline(%Lease{} = lease, _now, nil), do: lease

  defp maybe_extend_idle_deadline(%Lease{} = lease, now, idle_timeout_ms)
       when is_integer(idle_timeout_ms) and idle_timeout_ms > 0 do
    %{lease | idle_expires_at: DateTime.add(now, idle_timeout_ms, :millisecond)}
  end

  defp maybe_extend_idle_deadline(%Lease{} = lease, _now, _idle_timeout_ms), do: lease

  defp mark_stale_leases(%State{} = state, now) do
    Enum.reduce(state.leases, {state, []}, fn {_id, lease}, {acc_state, stale} ->
      if stale?(lease, now) do
        stale_lease = %{lease | status: "stale", updated_at: now}
        {put_lease(acc_state, stale_lease), [stale_lease | stale]}
      else
        {acc_state, stale}
      end
    end)
    |> then(fn {next_state, stale} -> {next_state, Enum.reverse(stale)} end)
  end

  defp stale?(%Lease{status: status}, _now) when status in @terminal_statuses, do: false

  defp stale?(%Lease{} = lease, now) do
    Enum.any?([lease.idle_expires_at, lease.max_expires_at, lease.lease_expires_at], &expired?(&1, now))
  end

  defp expired?(nil, _now), do: false
  defp expired?(%DateTime{} = deadline, now), do: DateTime.compare(deadline, now) in [:lt, :eq]

  defp orphaned_task?(%Lease{kind: "task", status: status, task_ref: task_ref}, active_task_refs)
       when status not in @terminal_statuses and is_binary(task_ref) and task_ref != "" do
    not MapSet.member?(active_task_refs, task_ref)
  end

  defp orphaned_task?(_lease, _active_task_refs), do: false

  defp now_from(opts) do
    case Keyword.get(opts || [], :now) do
      %DateTime{} = now -> now
      _ -> DateTime.utc_now()
    end
  end

  defp log_cleanup_metric(event, %Lease{} = lease) do
    Logger.info(
      "runtime_cleanup event=#{event} lease_id=#{lease.id} kind=#{lease.kind} status=#{lease.status} workspace_id=#{lease.workspace_id || "unknown"} agent_id=#{lease.agent_id || "unknown"} session_id=#{lease.session_id || "unknown"} run_id=#{lease.run_id || "unknown"}"
    )
  end
end
