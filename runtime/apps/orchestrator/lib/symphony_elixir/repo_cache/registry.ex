defmodule SymphonyElixir.RepoCache.Registry do
  @moduledoc """
  Tracks repository cache metadata and refresh leases.

  This establishes the Phase 2 API contract for repository registry records and
  repo-scoped refresh leases so later cache materialization work can reuse the
  same concurrency model.
  """

  use GenServer

  @default_lease_ttl_ms 300_000

  defmodule Repository do
    @moduledoc false

    @enforce_keys [:repo_id, :inserted_at, :updated_at]
    defstruct [
      :repo_id,
      :repo_url,
      :cache_path,
      :cache_kind,
      :last_fetched_at,
      :last_used_at,
      :cache_size_bytes,
      :active_session_count,
      :refresh_state,
      :inserted_at,
      :updated_at,
      metadata: %{}
    ]

    @type t :: %__MODULE__{
            repo_id: String.t(),
            repo_url: String.t() | nil,
            cache_path: String.t() | nil,
            cache_kind: String.t() | nil,
            last_fetched_at: DateTime.t() | nil,
            last_used_at: DateTime.t() | nil,
            cache_size_bytes: non_neg_integer() | nil,
            active_session_count: non_neg_integer() | nil,
            refresh_state: String.t() | nil,
            inserted_at: DateTime.t(),
            updated_at: DateTime.t(),
            metadata: map()
          }
  end

  defmodule RefreshLease do
    @moduledoc false

    @enforce_keys [:repo_id, :lease_owner, :lease_acquired_at, :lease_expires_at, :inserted_at, :updated_at]
    defstruct [
      :repo_id,
      :lease_owner,
      :lease_acquired_at,
      :lease_expires_at,
      :inserted_at,
      :updated_at
    ]

    @type t :: %__MODULE__{
            repo_id: String.t(),
            lease_owner: String.t(),
            lease_acquired_at: DateTime.t(),
            lease_expires_at: DateTime.t(),
            inserted_at: DateTime.t(),
            updated_at: DateTime.t()
          }
  end

  defmodule State do
    @moduledoc false

    @enforce_keys [:repositories, :refresh_leases]
    defstruct [:repositories, :refresh_leases]

    @type t :: %__MODULE__{
            repositories: %{optional(String.t()) => Repository.t()},
            refresh_leases: %{optional(String.t()) => RefreshLease.t()}
          }
  end

  @type server :: GenServer.server()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @spec upsert_repository(server(), map() | keyword()) :: {:ok, Repository.t()} | {:error, term()}
  def upsert_repository(server \\ __MODULE__, attrs) do
    GenServer.call(server, {:upsert_repository, normalize_attr_keys(Map.new(attrs)), now_from(nil)})
  end

  @spec touch_repository(server(), String.t(), map() | keyword()) ::
          {:ok, Repository.t()} | {:error, term()}
  def touch_repository(server \\ __MODULE__, repo_id, attrs \\ %{}) when is_binary(repo_id) do
    now = now_from(nil)

    attrs =
      attrs
      |> Map.new()
      |> normalize_attr_keys()
      |> Map.put(:repo_id, repo_id)
      |> Map.put_new(:last_used_at, now)

    GenServer.call(server, {:upsert_repository, attrs, now})
  end

  @spec get_repository(server(), String.t()) :: {:ok, Repository.t()} | :error
  def get_repository(server \\ __MODULE__, repo_id) when is_binary(repo_id) do
    GenServer.call(server, {:get_repository, repo_id})
  end

  @spec list_repositories(server()) :: [Repository.t()]
  def list_repositories(server \\ __MODULE__) do
    GenServer.call(server, :list_repositories)
  end

  @spec acquire_refresh_lease(server(), String.t(), String.t(), keyword()) ::
          {:ok, RefreshLease.t()} | {:error, term()}
  def acquire_refresh_lease(server \\ __MODULE__, repo_id, lease_owner, opts \\ [])
      when is_binary(repo_id) and is_binary(lease_owner) do
    GenServer.call(
      server,
      {:acquire_refresh_lease, repo_id, lease_owner, ttl_ms_from(opts), now_from(opts)}
    )
  end

  @spec renew_refresh_lease(server(), String.t(), String.t(), keyword()) ::
          {:ok, RefreshLease.t()} | {:error, term()}
  def renew_refresh_lease(server \\ __MODULE__, repo_id, lease_owner, opts \\ [])
      when is_binary(repo_id) and is_binary(lease_owner) do
    GenServer.call(
      server,
      {:renew_refresh_lease, repo_id, lease_owner, ttl_ms_from(opts), now_from(opts)}
    )
  end

  @spec release_refresh_lease(server(), String.t(), String.t()) :: :ok | {:error, term()}
  def release_refresh_lease(server \\ __MODULE__, repo_id, lease_owner)
      when is_binary(repo_id) and is_binary(lease_owner) do
    GenServer.call(server, {:release_refresh_lease, repo_id, lease_owner, now_from(nil)})
  end

  @spec get_refresh_lease(server(), String.t()) :: {:ok, RefreshLease.t()} | :error
  def get_refresh_lease(server \\ __MODULE__, repo_id) when is_binary(repo_id) do
    GenServer.call(server, {:get_refresh_lease, repo_id})
  end

  @spec list_refresh_leases(server()) :: [RefreshLease.t()]
  def list_refresh_leases(server \\ __MODULE__) do
    GenServer.call(server, :list_refresh_leases)
  end

  @spec expire_stale_leases(server(), keyword()) :: [RefreshLease.t()]
  def expire_stale_leases(server \\ __MODULE__, opts \\ []) do
    GenServer.call(server, {:expire_stale_leases, now_from(opts)})
  end

  @impl true
  def init(_opts) do
    {:ok, %State{repositories: %{}, refresh_leases: %{}}}
  end

  @impl true
  def handle_call({:upsert_repository, attrs, now}, _from, %State{} = state) do
    with {:ok, repo_id} <- fetch_repo_id(attrs) do
      repository =
        state.repositories
        |> Map.get(repo_id, new_repository(repo_id, now))
        |> merge_repository_attrs(attrs)
        |> Map.put(:updated_at, now)

      {:reply, {:ok, repository}, put_repository(state, repository)}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:get_repository, repo_id}, _from, %State{} = state) do
    case Map.fetch(state.repositories, repo_id) do
      {:ok, repository} -> {:reply, {:ok, repository}, state}
      :error -> {:reply, :error, state}
    end
  end

  def handle_call(:list_repositories, _from, %State{} = state) do
    repositories =
      state.repositories
      |> Map.values()
      |> Enum.sort_by(& &1.repo_id)

    {:reply, repositories, state}
  end

  def handle_call(
        {:acquire_refresh_lease, repo_id, lease_owner, ttl_ms, now},
        _from,
        %State{} = state
      ) do
    state = expire_stale_leases_in_state(state, now)

    case Map.get(state.refresh_leases, repo_id) do
      nil ->
        lease = new_refresh_lease(repo_id, lease_owner, ttl_ms, now)
        state = state |> put_refresh_lease(lease) |> upsert_repo_lease_state(repo_id, "leased", now)
        {:reply, {:ok, lease}, state}

      %RefreshLease{lease_owner: ^lease_owner} = existing_lease ->
        lease = %{existing_lease | lease_expires_at: add_ms(now, ttl_ms), updated_at: now}
        state = state |> put_refresh_lease(lease) |> upsert_repo_lease_state(repo_id, "leased", now)
        {:reply, {:ok, lease}, state}

      %RefreshLease{} = existing_lease ->
        {:reply, {:error, {:lease_unavailable, existing_lease}}, state}
    end
  end

  def handle_call(
        {:renew_refresh_lease, repo_id, lease_owner, ttl_ms, now},
        _from,
        %State{} = state
      ) do
    state = expire_stale_leases_in_state(state, now)

    case Map.get(state.refresh_leases, repo_id) do
      nil ->
        {:reply, {:error, :lease_not_found}, state}

      %RefreshLease{lease_owner: ^lease_owner} = lease ->
        renewed = %{lease | lease_expires_at: add_ms(now, ttl_ms), updated_at: now}
        state = state |> put_refresh_lease(renewed) |> upsert_repo_lease_state(repo_id, "leased", now)
        {:reply, {:ok, renewed}, state}

      %RefreshLease{} = lease ->
        {:reply, {:error, {:lease_owner_mismatch, lease}}, state}
    end
  end

  def handle_call({:release_refresh_lease, repo_id, lease_owner, now}, _from, %State{} = state) do
    case Map.get(state.refresh_leases, repo_id) do
      nil ->
        {:reply, :ok, state}

      %RefreshLease{lease_owner: ^lease_owner} ->
        state =
          state
          |> delete_refresh_lease(repo_id)
          |> upsert_repo_lease_state(repo_id, "idle", now)

        {:reply, :ok, state}

      %RefreshLease{} = lease ->
        {:reply, {:error, {:lease_owner_mismatch, lease}}, state}
    end
  end

  def handle_call({:get_refresh_lease, repo_id}, _from, %State{} = state) do
    case Map.fetch(state.refresh_leases, repo_id) do
      {:ok, lease} -> {:reply, {:ok, lease}, state}
      :error -> {:reply, :error, state}
    end
  end

  def handle_call(:list_refresh_leases, _from, %State{} = state) do
    refresh_leases =
      state.refresh_leases
      |> Map.values()
      |> Enum.sort_by(& &1.repo_id)

    {:reply, refresh_leases, state}
  end

  def handle_call({:expire_stale_leases, now}, _from, %State{} = state) do
    {state, expired_leases} = pop_expired_leases(state, now)
    {:reply, expired_leases, state}
  end

  defp fetch_repo_id(%{repo_id: repo_id}) when is_binary(repo_id) and repo_id != "", do: {:ok, repo_id}
  defp fetch_repo_id(%{"repo_id" => repo_id}) when is_binary(repo_id) and repo_id != "", do: {:ok, repo_id}
  defp fetch_repo_id(_attrs), do: {:error, :missing_repo_id}

  defp normalize_attr_keys(attrs) when is_map(attrs) do
    Enum.reduce(attrs, %{}, fn
      {"repo_id", value}, normalized -> Map.put(normalized, :repo_id, value)
      {"repo_url", value}, normalized -> Map.put(normalized, :repo_url, value)
      {"cache_path", value}, normalized -> Map.put(normalized, :cache_path, value)
      {"cache_kind", value}, normalized -> Map.put(normalized, :cache_kind, value)
      {"last_fetched_at", value}, normalized -> Map.put(normalized, :last_fetched_at, value)
      {"last_used_at", value}, normalized -> Map.put(normalized, :last_used_at, value)
      {"cache_size_bytes", value}, normalized -> Map.put(normalized, :cache_size_bytes, value)
      {"active_session_count", value}, normalized -> Map.put(normalized, :active_session_count, value)
      {"refresh_state", value}, normalized -> Map.put(normalized, :refresh_state, value)
      {"metadata", value}, normalized -> Map.put(normalized, :metadata, value)
      {key, value}, normalized -> Map.put(normalized, key, value)
    end)
  end

  defp merge_repository_attrs(%Repository{} = repository, attrs) do
    allowed_fields = [
      :repo_url,
      :cache_path,
      :cache_kind,
      :last_fetched_at,
      :last_used_at,
      :cache_size_bytes,
      :active_session_count,
      :refresh_state,
      :metadata
    ]

    Enum.reduce(allowed_fields, repository, fn field, acc ->
      case Map.fetch(attrs, field) do
        {:ok, value} -> Map.put(acc, field, value)
        :error -> acc
      end
    end)
  end

  defp new_repository(repo_id, now) do
    %Repository{
      repo_id: repo_id,
      inserted_at: now,
      updated_at: now,
      refresh_state: "idle"
    }
  end

  defp put_repository(%State{} = state, %Repository{} = repository) do
    %{state | repositories: Map.put(state.repositories, repository.repo_id, repository)}
  end

  defp new_refresh_lease(repo_id, lease_owner, ttl_ms, now) do
    %RefreshLease{
      repo_id: repo_id,
      lease_owner: lease_owner,
      lease_acquired_at: now,
      lease_expires_at: add_ms(now, ttl_ms),
      inserted_at: now,
      updated_at: now
    }
  end

  defp put_refresh_lease(%State{} = state, %RefreshLease{} = refresh_lease) do
    %{state | refresh_leases: Map.put(state.refresh_leases, refresh_lease.repo_id, refresh_lease)}
  end

  defp delete_refresh_lease(%State{} = state, repo_id) do
    %{state | refresh_leases: Map.delete(state.refresh_leases, repo_id)}
  end

  defp expire_stale_leases_in_state(%State{} = state, now) do
    {state, _expired_leases} = pop_expired_leases(state, now)
    state
  end

  defp pop_expired_leases(%State{} = state, now) do
    Enum.reduce(state.refresh_leases, {state, []}, fn {repo_id, lease}, {acc_state, expired} ->
      if DateTime.compare(lease.lease_expires_at, now) in [:lt, :eq] do
        next_state =
          acc_state
          |> delete_refresh_lease(repo_id)
          |> upsert_repo_lease_state(repo_id, "stale", now)

        {next_state, [lease | expired]}
      else
        {acc_state, expired}
      end
    end)
    |> then(fn {next_state, expired} -> {next_state, Enum.reverse(expired)} end)
  end

  defp upsert_repo_lease_state(%State{} = state, repo_id, refresh_state, now) do
    repository =
      state.repositories
      |> Map.get(repo_id, new_repository(repo_id, now))
      |> Map.put(:refresh_state, refresh_state)
      |> Map.put(:updated_at, now)
      |> Map.put_new(:last_used_at, now)

    put_repository(state, repository)
  end

  defp ttl_ms_from(opts) do
    case Keyword.get(opts, :ttl_ms, @default_lease_ttl_ms) do
      ttl_ms when is_integer(ttl_ms) and ttl_ms > 0 -> ttl_ms
      _ -> @default_lease_ttl_ms
    end
  end

  defp now_from(opts) do
    case Keyword.get(opts || [], :now) do
      %DateTime{} = now -> now
      _ -> DateTime.utc_now()
    end
  end

  defp add_ms(%DateTime{} = datetime, ttl_ms) when is_integer(ttl_ms) do
    DateTime.add(datetime, ttl_ms, :millisecond)
  end
end
