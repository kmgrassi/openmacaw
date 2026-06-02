defmodule SymphonyElixir.LocalRelay.Presence do
  @moduledoc """
  Tracks online local runtime helper sockets.

  This is intentionally limited to connection presence and heartbeat state for
  PR1. Dispatch selection and busy/timeout semantics belong to the relay
  registry and runner adapter work in a later PR.
  """

  use GenServer

  @type runner :: %{
          required(:runner_kind) => String.t(),
          optional(:provider) => String.t(),
          optional(:model) => String.t(),
          optional(:capabilities) => map()
        }

  @type registration :: %{
          required(:workspace_id) => String.t(),
          required(:machine_id) => String.t(),
          optional(:token_id) => String.t(),
          optional(:runner_kinds) => [String.t()],
          optional(:runners) => [runner()],
          optional(:metadata) => map(),
          optional(:last_seen_ms) => integer(),
          optional(:connected_at_ms) => integer(),
          optional(:connection_pid) => pid()
        }

  @type key :: {String.t(), String.t()}

  @doc false
  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]}
    }
  end

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, %{}, name: name)
  end

  @doc """
  Mark a helper as online.
  """
  @spec register(registration()) :: :ok | {:error, :workspace_connection_limit_exceeded}
  def register(%{workspace_id: workspace_id, machine_id: machine_id} = registration)
      when is_binary(workspace_id) and is_binary(machine_id) do
    GenServer.call(__MODULE__, {:register, registration})
  end

  @doc """
  Refresh heartbeat data for an online helper.
  """
  @spec heartbeat(String.t(), String.t(), map()) :: :ok | {:error, :not_registered}
  def heartbeat(workspace_id, machine_id, updates \\ %{})
      when is_binary(workspace_id) and is_binary(machine_id) and is_map(updates) do
    GenServer.call(__MODULE__, {:heartbeat, workspace_id, machine_id, updates})
  end

  @doc """
  Mark a helper offline.
  """
  @spec offline(String.t(), String.t()) :: :ok
  def offline(workspace_id, machine_id) when is_binary(workspace_id) and is_binary(machine_id) do
    GenServer.call(__MODULE__, {:offline, workspace_id, machine_id})
  end

  @doc """
  Mark a helper offline only if the stored connection matches `connection_pid`.
  """
  @spec offline(String.t(), String.t(), pid()) :: :ok | :stale
  def offline(workspace_id, machine_id, connection_pid)
      when is_binary(workspace_id) and is_binary(machine_id) and is_pid(connection_pid) do
    GenServer.call(__MODULE__, {:offline, workspace_id, machine_id, connection_pid})
  end

  @doc """
  Return presence data for a helper.
  """
  @spec get(String.t(), String.t()) :: {:ok, registration()} | {:error, :not_found}
  def get(workspace_id, machine_id) when is_binary(workspace_id) and is_binary(machine_id) do
    GenServer.call(__MODULE__, {:get, workspace_id, machine_id})
  end

  @doc """
  List all currently online helpers.
  """
  @spec list() :: [registration()]
  def list do
    GenServer.call(__MODULE__, :list)
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:register, registration}, _from, state) do
    now = now_ms()

    record =
      registration
      |> Map.put(:connected_at_ms, now)
      |> Map.put(:last_seen_ms, now)
      |> Map.put_new(:runner_kinds, [])
      |> Map.put_new(:runners, [])
      |> Map.put_new(:metadata, %{})

    state = evict_duplicate_token_connections(state, record)
    key = key(record.workspace_id, record.machine_id)
    state = evict_existing_machine_connection(state, key, record.connection_pid)

    if workspace_connection_count(state, record.workspace_id) >= max_connections_per_workspace() do
      {:reply, {:error, :workspace_connection_limit_exceeded}, state}
    else
      {:reply, :ok, Map.put(state, key, record)}
    end
  end

  def handle_call({:heartbeat, workspace_id, machine_id, updates}, _from, state) do
    key = key(workspace_id, machine_id)

    case Map.fetch(state, key) do
      {:ok, existing} ->
        record =
          existing
          |> Map.merge(Map.take(updates, [:runner_kinds, :runners, :metadata]))
          |> Map.put(:last_seen_ms, now_ms())

        {:reply, :ok, Map.put(state, key, record)}

      :error ->
        {:reply, {:error, :not_registered}, state}
    end
  end

  def handle_call({:offline, workspace_id, machine_id}, _from, state) do
    {:reply, :ok, Map.delete(state, key(workspace_id, machine_id))}
  end

  def handle_call({:offline, workspace_id, machine_id, connection_pid}, _from, state) do
    key = key(workspace_id, machine_id)

    {reply, state} =
      case Map.fetch(state, key) do
        {:ok, %{connection_pid: ^connection_pid}} -> {:ok, Map.delete(state, key)}
        _other -> {:stale, state}
      end

    {:reply, reply, state}
  end

  def handle_call({:get, workspace_id, machine_id}, _from, state) do
    case Map.fetch(state, key(workspace_id, machine_id)) do
      {:ok, record} -> {:reply, {:ok, record}, state}
      :error -> {:reply, {:error, :not_found}, state}
    end
  end

  def handle_call(:list, _from, state) do
    {:reply, Map.values(state), state}
  end

  defp key(workspace_id, machine_id), do: {workspace_id, machine_id}
  defp now_ms, do: System.system_time(:millisecond)

  defp evict_duplicate_token_connections(state, %{token_hash: token_hash} = record)
       when is_binary(token_hash) and token_hash != "" do
    state
    |> Enum.reject(fn
      {{workspace_id, _machine_id}, existing} ->
        workspace_id == record.workspace_id and Map.get(existing, :token_hash) == token_hash and
          Map.get(existing, :connection_pid) != record.connection_pid
    end)
    |> Map.new()
    |> tap(fn updated ->
      state
      |> Map.drop(Map.keys(updated))
      |> notify_evicted_connections(:duplicate_token)
    end)
  end

  defp evict_duplicate_token_connections(state, _record), do: state

  defp evict_existing_machine_connection(state, key, connection_pid) do
    case Map.fetch(state, key) do
      {:ok, existing} ->
        if Map.get(existing, :connection_pid) != connection_pid do
          notify_evicted_connections(%{key => existing}, :duplicate_machine)
          Map.delete(state, key)
        else
          state
        end

      _other ->
        state
    end
  end

  defp notify_evicted_connections(records, reason) do
    Enum.each(records, fn {_key, record} ->
      case Map.get(record, :connection_pid) do
        pid when is_pid(pid) -> send(pid, {:local_relay_evicted, reason})
        _missing_pid -> :ok
      end
    end)
  end

  defp workspace_connection_count(state, workspace_id) do
    Enum.count(state, fn {{existing_workspace_id, _machine_id}, _record} -> existing_workspace_id == workspace_id end)
  end

  defp max_connections_per_workspace do
    case Application.get_env(:symphony_elixir, :local_relay_max_connections_per_workspace, 100) do
      value when is_integer(value) and value > 0 -> value
      _invalid -> 100
    end
  end
end
