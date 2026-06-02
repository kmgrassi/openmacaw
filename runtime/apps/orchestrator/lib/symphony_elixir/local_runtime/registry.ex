defmodule SymphonyElixir.LocalRuntime.Registry do
  @moduledoc """
  In-memory latest-state registry for local helper capability snapshots.

  Platform-owned persistence can consume these normalized snapshots through the
  controller/API layer. The registry intentionally stores only latest state; it
  does not try to be a historical capability database.
  """

  use GenServer

  alias SymphonyElixir.LocalRuntime.Capabilities
  alias SymphonyElixir.RuntimeLog

  @type entry :: Capabilities.entry()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, Keyword.put_new(opts, :name, __MODULE__))
  end

  @impl true
  def init(state), do: {:ok, state}

  @spec register(map(), keyword()) :: {:ok, [entry()]} | {:error, term()}
  def register(frame, opts \\ []) do
    upsert(frame, :register, opts)
  end

  @spec probe(map(), keyword()) :: {:ok, [entry()]} | {:error, term()}
  def probe(frame, opts \\ []) do
    upsert(frame, :probe, opts)
  end

  @spec list(keyword()) :: [entry()]
  def list(filters \\ []) do
    GenServer.call(__MODULE__, {:list, filters})
  end

  @spec get(String.t(), String.t(), String.t(), String.t()) :: {:ok, entry()} | {:error, :not_found}
  def get(workspace_id, machine_id, runner_kind, model) do
    get(workspace_id, machine_id, runner_kind, nil, model)
  end

  @spec get(String.t(), String.t(), String.t(), String.t() | nil, String.t()) :: {:ok, entry()} | {:error, :not_found}
  def get(workspace_id, machine_id, runner_kind, provider, model) do
    GenServer.call(__MODULE__, {:get, workspace_id, machine_id, runner_kind, provider, model})
  end

  @spec clear() :: :ok
  def clear do
    GenServer.call(__MODULE__, :clear)
  end

  defp upsert(frame, source, opts) do
    with {:ok, entries} <- Capabilities.normalize_frame(frame, opts) do
      GenServer.call(__MODULE__, {:upsert, source, entries})
    end
  end

  @impl true
  def handle_call({:upsert, source, entries}, _from, state) do
    state =
      Enum.reduce(entries, state, fn entry, acc ->
        Map.put(acc, key(entry), Map.put(entry, "source", Atom.to_string(source)))
      end)

    Enum.each(entries, fn entry ->
      RuntimeLog.log(:info, :local_runtime_capability_snapshot, %{
        workspace_id: entry["workspace_id"],
        machine_id: entry["machine_id"],
        runner_kind: entry["runner_kind"],
        provider: entry["provider"],
        model: entry["model"],
        capability_snapshot_id: entry["snapshot_id"],
        source: source
      })
    end)

    {:reply, {:ok, entries}, state}
  end

  def handle_call({:list, filters}, _from, state) do
    entries =
      state
      |> Map.values()
      |> Enum.filter(&matches_filters?(&1, filters))
      |> Enum.sort_by(&{&1["workspace_id"], &1["machine_id"], &1["runner_kind"], &1["provider"], &1["model"]})

    {:reply, entries, state}
  end

  def handle_call({:get, workspace_id, machine_id, runner_kind, provider, model}, _from, state) do
    case Map.fetch(state, {workspace_id, machine_id, runner_kind, provider, model}) do
      {:ok, entry} -> {:reply, {:ok, entry}, state}
      :error -> {:reply, {:error, :not_found}, state}
    end
  end

  def handle_call(:clear, _from, _state), do: {:reply, :ok, %{}}

  defp matches_filters?(entry, filters) do
    Enum.all?(filters, fn
      {:workspace_id, nil} -> true
      {:machine_id, nil} -> true
      {:runner_kind, nil} -> true
      {:provider, nil} -> true
      {:model, nil} -> true
      {:workspace_id, value} -> entry["workspace_id"] == value
      {:machine_id, value} -> entry["machine_id"] == value
      {:runner_kind, value} -> entry["runner_kind"] == value
      {:provider, value} -> entry["provider"] == value
      {:model, value} -> entry["model"] == value
      _other -> true
    end)
  end

  defp key(entry), do: {entry["workspace_id"], entry["machine_id"], entry["runner_kind"], entry["provider"], entry["model"]}
end
