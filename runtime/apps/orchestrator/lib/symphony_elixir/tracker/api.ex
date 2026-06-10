defmodule SymphonyElixir.Tracker.API do
  @moduledoc """
  Tracker adapter that accepts work items via HTTP push.

  Instead of polling an external system, this adapter holds an in-memory queue
  of work items that are pushed in via `POST /api/v1/items` on the orchestrator
  HTTP server.

  Items are held in a GenServer and returned by `fetch_candidate_issues/0` on
  each poll cycle. Once dispatched and completed, items are removed.

  ## Use cases

  - GitHub Actions pushes a task directly
  - API server pushes a task without waiting for poll
  - CI/CD pipelines, cron jobs, or any external system

  ## Lifecycle

  1. External caller POSTs to `POST /api/v1/items` with work item payload
  2. Router calls `Tracker.API.accept_item(payload)`
  3. Item is stored in GenServer state
  4. Orchestrator polls `fetch_candidate_issues/0`, gets the item
  5. Item is dispatched, runs through agent lifecycle
  6. On completion, `update_issue_state/2` moves item to terminal state
  """

  @behaviour SymphonyElixir.Tracker

  use GenServer

  alias SymphonyElixir.Config
  alias SymphonyElixir.WorkItem
  alias SymphonyElixir.WorkItem.Mapper, as: WorkItemMapper

  @required_fields ~w(title)

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec accept_item(map()) :: {:ok, WorkItem.t()} | {:error, term()}
  def accept_item(payload) do
    GenServer.call(__MODULE__, {:accept_item, payload})
  end

  def fetch_candidate_issues do
    config = Config.settings!().tracker
    active = MapSet.new(config.active_states, &String.downcase/1)

    GenServer.call(__MODULE__, {:fetch_by_states, active})
  end

  @impl SymphonyElixir.Tracker
  def fetch_candidate_issues(_workspace_id), do: fetch_candidate_issues()

  def fetch_issues_by_states(state_names) do
    normalized = MapSet.new(state_names, &String.downcase/1)
    GenServer.call(__MODULE__, {:fetch_by_states, normalized})
  end

  @impl SymphonyElixir.Tracker
  def fetch_issues_by_states(_workspace_id, state_names), do: fetch_issues_by_states(state_names)

  def fetch_issue_states_by_ids(issue_ids) do
    wanted = MapSet.new(issue_ids)
    GenServer.call(__MODULE__, {:fetch_by_ids, wanted})
  end

  @impl SymphonyElixir.Tracker
  def fetch_issue_states_by_ids(_workspace_id, issue_ids), do: fetch_issue_states_by_ids(issue_ids)

  def create_comment(_issue_id, _body) do
    # No external system to comment on — silently succeed
    :ok
  end

  @impl SymphonyElixir.Tracker
  def create_comment(_workspace_id, issue_id, body), do: create_comment(issue_id, body)

  def update_issue_state(%WorkItem{id: id}, state_name), do: update_issue_state(id, state_name)

  def update_issue_state(issue_id, state_name) do
    GenServer.call(__MODULE__, {:update_issue_state, issue_id, state_name})
  end

  @impl SymphonyElixir.Tracker
  def update_issue_state(_workspace_id, issue_or_id, state_name), do: update_issue_state(issue_or_id, state_name)

  # GenServer callbacks

  @impl GenServer
  def init(_opts) do
    {:ok, %{items: %{}}}
  end

  @impl GenServer
  def handle_call({:accept_item, payload}, _from, state) do
    case validate_and_normalize(payload) do
      {:ok, work_item} ->
        new_state = put_in(state, [:items, work_item.id], work_item)
        {:reply, {:ok, work_item}, new_state}

      {:error, _} = err ->
        {:reply, err, state}
    end
  end

  @impl GenServer
  def handle_call({:fetch_by_states, state_set}, _from, state) do
    filtered =
      state.items
      |> Map.values()
      |> Enum.filter(fn item ->
        MapSet.member?(state_set, String.downcase(item.state || ""))
      end)

    {:reply, {:ok, filtered}, state}
  end

  @impl GenServer
  def handle_call({:fetch_by_ids, id_set}, _from, state) do
    filtered =
      state.items
      |> Map.values()
      |> Enum.filter(fn item -> MapSet.member?(id_set, item.id) end)

    {:reply, {:ok, filtered}, state}
  end

  @impl GenServer
  def handle_call({:update_issue_state, issue_id, state_name}, _from, state) do
    case Map.get(state.items, issue_id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      item ->
        updated = %{item | state: state_name}
        new_state = put_in(state, [:items, issue_id], updated)
        {:reply, :ok, new_state}
    end
  end

  defp validate_and_normalize(payload) when is_map(payload) do
    with {:ok, normalized_payload, normalization_feedback} <- WorkItemMapper.normalize_intake_payload(payload) do
      missing = Enum.filter(@required_fields, fn f -> blank?(normalized_payload[f]) end)

      if missing != [] do
        {:error, {:missing_fields, missing}}
      else
        {:ok, normalized_payload |> WorkItemMapper.from_api_payload() |> maybe_put_normalization_feedback(normalization_feedback)}
      end
    end
  end

  defp validate_and_normalize(_), do: {:error, :invalid_payload}

  defp maybe_put_normalization_feedback(%WorkItem{} = work_item, [_ | _] = feedback) do
    metadata = Map.put(work_item.metadata || %{}, "normalization_feedback", feedback)
    %{work_item | metadata: metadata}
  end

  defp maybe_put_normalization_feedback(%WorkItem{} = work_item, _feedback), do: work_item

  defp blank?(nil), do: true
  defp blank?(""), do: true
  defp blank?(_), do: false
end
