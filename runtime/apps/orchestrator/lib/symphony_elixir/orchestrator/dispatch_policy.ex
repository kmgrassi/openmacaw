defmodule SymphonyElixir.Orchestrator.DispatchPolicy do
  @moduledoc """
  Pure dispatch eligibility, sorting, and slot-check helpers used by the
  orchestrator polling loop. The orchestrator GenServer remains responsible
  for state transitions and side effects; this module exposes the
  decision-making predicates as plain functions that are easy to unit test
  in isolation.
  """

  require Logger

  alias SymphonyElixir.{Config, WorkItem}
  alias SymphonyElixir.Orchestrator.State

  @max_created_at_sort_key 9_223_372_036_854_775_807

  @spec dispatch_eligible?(WorkItem.t(), State.t()) :: boolean()
  def dispatch_eligible?(%WorkItem{} = issue, %State{} = state) do
    dispatch_eligible?(issue, state, active_state_set(), terminal_state_set())
  end

  @spec dispatch_summary_for_row(map()) :: map()
  def dispatch_summary_for_row(row) when is_map(row) do
    reason = dispatch_summary_reason(row)

    %{
      "eligible" => reason == "ready",
      "reason" => reason,
      "blocked_by" => dispatch_blockers(row),
      "runner_kind" => row_runner_kind(row),
      "repository" => row_repository(row)
    }
  end

  def dispatch_summary_for_row(_row) do
    %{
      "eligible" => false,
      "reason" => "invalid_for_orchestrator",
      "blocked_by" => [],
      "runner_kind" => nil,
      "repository" => nil
    }
  end

  @spec dispatch_eligible?(WorkItem.t(), State.t(), MapSet.t(), MapSet.t()) :: boolean()
  def dispatch_eligible?(
        %WorkItem{} = issue,
        %State{running: running, claimed: claimed} = state,
        active_states,
        terminal_states
      ) do
    candidate_ok = candidate_issue?(issue, active_states, terminal_states)
    blocked_ok = !todo_issue_blocked_by_non_terminal?(issue, terminal_states)
    not_claimed = !MapSet.member?(claimed, issue.id)
    not_running = !Map.has_key?(running, issue.id)
    capacity_skip_reason = capacity_skip_reason(issue, state)
    global_slots_ok = is_nil(capacity_skip_reason)
    state_slots_ok = state_slots_available?(issue, running)

    Logger.debug(
      "Dispatch gate eval for #{issue_context(issue)}: candidate=#{candidate_ok} blocked_by_non_terminal=#{!blocked_ok} not_claimed=#{not_claimed} not_running=#{not_running} global_slots_ok=#{global_slots_ok} state_slots_ok=#{state_slots_ok} capacity_skip_reason=#{inspect(capacity_skip_reason)}"
    )

    candidate_ok and blocked_ok and not_claimed and not_running and global_slots_ok and
      state_slots_ok
  end

  def dispatch_eligible?(_issue, _state, _active_states, _terminal_states), do: false

  @spec sort_issues_for_dispatch([WorkItem.t()]) :: [WorkItem.t()]
  def sort_issues_for_dispatch(issues) when is_list(issues) do
    Enum.sort_by(issues, fn
      %WorkItem{} = issue ->
        {priority_rank(issue.priority), issue_created_at_sort_key(issue), issue.identifier || issue.id || ""}

      _ ->
        {priority_rank(nil), issue_created_at_sort_key(nil), ""}
    end)
  end

  @spec revalidate_issue_for_dispatch(WorkItem.t(), ([String.t()] -> term())) ::
          {:ok, WorkItem.t()} | {:skip, WorkItem.t() | :missing} | {:error, term()}
  def revalidate_issue_for_dispatch(%WorkItem{} = issue, issue_fetcher)
      when is_function(issue_fetcher, 1) do
    revalidate_issue_for_dispatch(issue, issue_fetcher, terminal_state_set())
  end

  @spec revalidate_issue_for_dispatch(WorkItem.t(), ([String.t()] -> term()), MapSet.t()) ::
          {:ok, WorkItem.t()} | {:skip, WorkItem.t() | :missing} | {:error, term()}
  def revalidate_issue_for_dispatch(%WorkItem{id: issue_id}, issue_fetcher, terminal_states)
      when is_binary(issue_id) and is_function(issue_fetcher, 1) do
    case issue_fetcher.([issue_id]) do
      {:ok, [%WorkItem{} = refreshed_issue | _]} ->
        if retry_candidate_issue?(refreshed_issue, terminal_states) do
          {:ok, refreshed_issue}
        else
          {:skip, refreshed_issue}
        end

      {:ok, []} ->
        {:skip, :missing}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def revalidate_issue_for_dispatch(issue, _issue_fetcher, _terminal_states), do: {:ok, issue}

  @spec retry_candidate_issue?(WorkItem.t(), MapSet.t()) :: boolean()
  def retry_candidate_issue?(%WorkItem{} = issue, terminal_states) do
    candidate_issue?(issue, active_state_set(), terminal_states) and
      !todo_issue_blocked_by_non_terminal?(issue, terminal_states)
  end

  @spec candidate_issue?(WorkItem.t(), MapSet.t(), MapSet.t()) :: boolean()
  def candidate_issue?(
        %WorkItem{
          id: id,
          identifier: identifier,
          title: title,
          state: state_name
        } = issue,
        active_states,
        terminal_states
      )
      when is_binary(id) and is_binary(identifier) and is_binary(title) and is_binary(state_name) do
    routable_ok = issue_routable_to_worker?(issue)
    active_ok = active_issue_state?(state_name, active_states)
    terminal_ok = !terminal_issue_state?(state_name, terminal_states)

    if !routable_ok do
      Logger.debug("Queue candidate failed at routing gate: #{issue_context(issue)} assigned_to_worker=#{inspect(issue.metadata[:assignee_id])}")
    end

    if !active_ok do
      Logger.debug("Queue candidate failed at state gate: #{issue_context(issue)} state=#{state_name}")
    end

    if !terminal_ok do
      Logger.debug("Queue candidate failed at terminal gate: #{issue_context(issue)} state=#{state_name}")
    end

    routable_ok and active_ok and terminal_ok
  end

  def candidate_issue?(_issue, _active_states, _terminal_states), do: false

  @spec issue_routable_to_worker?(WorkItem.t()) :: boolean()
  def issue_routable_to_worker?(%WorkItem{assigned_to_worker: assigned_to_worker})
      when is_boolean(assigned_to_worker),
      do: assigned_to_worker

  def issue_routable_to_worker?(_issue), do: true

  @spec terminal_issue_state?(String.t() | nil, MapSet.t()) :: boolean()
  def terminal_issue_state?(state_name, terminal_states) when is_binary(state_name) do
    MapSet.member?(terminal_states, normalize_issue_state(state_name))
  end

  def terminal_issue_state?(_state_name, _terminal_states), do: false

  @spec active_issue_state?(String.t() | nil, MapSet.t()) :: boolean()
  def active_issue_state?(state_name, active_states) when is_binary(state_name) do
    MapSet.member?(active_states, normalize_issue_state(state_name))
  end

  def active_issue_state?(_state_name, _active_states), do: false

  @spec normalize_issue_state(String.t()) :: String.t()
  def normalize_issue_state(state_name) when is_binary(state_name) do
    String.downcase(String.trim(state_name))
  end

  @spec terminal_state_set() :: MapSet.t()
  def terminal_state_set do
    Config.settings!().tracker.terminal_states
    |> Enum.map(&normalize_issue_state/1)
    |> Enum.filter(&(&1 != ""))
    |> MapSet.new()
  end

  @spec active_state_set() :: MapSet.t()
  def active_state_set do
    Config.settings!().tracker.active_states
    |> Enum.map(&normalize_issue_state/1)
    |> Enum.filter(&(&1 != ""))
    |> MapSet.new()
  end

  @spec available_slots(State.t()) :: non_neg_integer()
  def available_slots(%State{} = state) do
    state
    |> slot_limits()
    |> Enum.min(fn -> 0 end)
  end

  @spec effective_global_cap(State.t()) :: non_neg_integer()
  def effective_global_cap(%State{} = state) do
    [
      state.max_concurrent_agents || Config.settings!().agent.max_concurrent_agents,
      Map.get(state, :workspace_max_concurrent_agents)
    ]
    |> Enum.filter(&is_integer/1)
    |> case do
      [] -> 0
      caps -> Enum.min(caps)
    end
  end

  @spec capacity_skip_reason(WorkItem.t(), State.t()) :: atom() | nil
  def capacity_skip_reason(%WorkItem{} = issue, %State{} = state) do
    cond do
      Map.get(state, :workspace_cap_error) ->
        :workspace_capacity_unavailable

      workspace_capacity_full?(state) ->
        :workspace_capacity_full

      available_slots(state) <= 0 ->
        :workflow_capacity_full

      !state_slots_available?(issue, state.running) ->
        :state_capacity_full

      true ->
        nil
    end
  end

  def capacity_skip_reason(_issue, _state), do: :invalid_dispatch_candidate

  @spec dispatch_slots_available?(WorkItem.t(), State.t()) :: boolean()
  def dispatch_slots_available?(%WorkItem{} = issue, %State{} = state) do
    is_nil(capacity_skip_reason(issue, state))
  end

  @spec state_slots_available?(WorkItem.t(), map()) :: boolean()
  def state_slots_available?(%WorkItem{state: issue_state}, running) when is_map(running) do
    limit = Config.max_concurrent_agents_for_state(issue_state)
    used = running_issue_count_for_state(running, issue_state)
    available = limit > used
    Logger.debug("State slot check issue_state=#{issue_state} state_limit=#{limit} state_used=#{used} available=#{available}")
    available
  end

  def state_slots_available?(_issue, _running), do: false

  defp running_issue_count_for_state(running, issue_state) when is_map(running) do
    normalized_state = normalize_issue_state(issue_state)

    Enum.count(running, fn
      {_id, %{issue: %WorkItem{state: state_name}}} ->
        normalize_issue_state(state_name) == normalized_state

      _ ->
        false
    end)
  end

  defp workspace_capacity_full?(%State{} = state) do
    case Map.get(state, :workspace_max_concurrent_agents) do
      cap when is_integer(cap) -> workspace_active_agents_count(state) >= cap
      _ -> false
    end
  end

  defp slot_limits(%State{} = state) do
    [workflow_available_slots(state)]
    |> maybe_append_workspace_slots(workspace_available_slots(state))
  end

  defp workflow_available_slots(%State{} = state) do
    max((state.max_concurrent_agents || Config.settings!().agent.max_concurrent_agents) - map_size(state.running), 0)
  end

  defp workspace_available_slots(%State{} = state) do
    case Map.get(state, :workspace_max_concurrent_agents) do
      cap when is_integer(cap) -> max(cap - workspace_active_agents_count(state), 0)
      _ -> nil
    end
  end

  defp workspace_active_agents_count(%State{} = state) do
    case Map.get(state, :workspace_active_agents_count) do
      count when is_integer(count) and count >= 0 -> count
      _ -> map_size(state.running)
    end
  end

  defp maybe_append_workspace_slots(slots, workspace_slots) when is_integer(workspace_slots),
    do: [workspace_slots | slots]

  defp maybe_append_workspace_slots(slots, _workspace_slots), do: slots

  defp todo_issue_blocked_by_non_terminal?(
         %WorkItem{state: issue_state, metadata: %{blocked_by: blockers}},
         terminal_states
       )
       when is_binary(issue_state) and is_list(blockers) do
    blocked =
      normalize_issue_state(issue_state) == "todo" and
        Enum.any?(blockers, fn
          %{state: blocker_state} when is_binary(blocker_state) ->
            !terminal_issue_state?(blocker_state, terminal_states)

          _ ->
            true
        end)

    if blocked do
      Logger.debug("Queue candidate failed at blocker gate: issue_state=#{issue_state} blockers=#{length(blockers)}")
    end

    blocked
  end

  defp todo_issue_blocked_by_non_terminal?(_issue, _terminal_states), do: false

  defp dispatch_summary_reason(row) do
    cond do
      !valid_dispatch_row?(row) ->
        "invalid_for_orchestrator"

      draft_or_paused?(row) ->
        "draft_or_paused"

      dependency_blocked?(row) ->
        "blocked_by_dependencies"

      waiting_until_next_poll_at?(row) ->
        "waiting_until_next_poll_at"

      missing_route?(row) ->
        "missing_route"

      true ->
        "ready"
    end
  end

  defp valid_dispatch_row?(row) do
    present_string?(Map.get(row, "id")) and
      present_string?(Map.get(row, "title") || Map.get(row, "name")) and
      present_string?(Map.get(row, "state") || Map.get(row, "status"))
  end

  defp draft_or_paused?(row) do
    state = row |> row_state() |> normalize_issue_state()
    state in ["draft", "paused"]
  end

  defp dependency_blocked?(row), do: dispatch_blockers(row) != []

  defp waiting_until_next_poll_at?(row) do
    case Map.get(row, "next_poll_at") do
      value when is_binary(value) ->
        case DateTime.from_iso8601(value) do
          {:ok, datetime, _offset} -> DateTime.compare(datetime, DateTime.utc_now()) == :gt
          {:error, _reason} -> false
        end

      _ ->
        false
    end
  end

  defp missing_route?(row), do: !present_string?(row_runner_kind(row))

  defp dispatch_blockers(row) do
    cond do
      non_empty_list?(Map.get(row, "depends_on")) ->
        Map.get(row, "depends_on")

      non_empty_list?(metadata_blocked_by(row)) ->
        metadata_blocked_by(row)

      true ->
        []
    end
  end

  defp metadata_blocked_by(row) do
    metadata = row_metadata(row)
    Map.get(metadata, "blocked_by") || Map.get(metadata, :blocked_by)
  end

  defp row_runner_kind(row) do
    metadata = row_metadata(row)
    routing = row_routing(row)

    Map.get(row, "runner_kind") ||
      Map.get(metadata, "runner_kind") ||
      Map.get(routing, "runner_kind")
  end

  defp row_repository(row) do
    metadata = row_metadata(row)

    Map.get(row, "repository") ||
      Map.get(metadata, "repository") ||
      Map.get(metadata, "repository_id")
  end

  defp row_state(row), do: Map.get(row, "state") || Map.get(row, "status") || ""

  defp row_metadata(row) do
    case Map.get(row, "metadata") do
      metadata when is_map(metadata) -> metadata
      _ -> %{}
    end
  end

  defp row_routing(row) do
    case row |> row_metadata() |> Map.get("routing") do
      routing when is_map(routing) -> routing
      _ -> %{}
    end
  end

  defp non_empty_list?(value), do: is_list(value) and value != []

  defp present_string?(value) when is_binary(value), do: String.trim(value) != ""
  defp present_string?(_value), do: false

  defp priority_rank(priority) when is_integer(priority) and priority in 1..4, do: priority

  defp priority_rank(priority) when is_binary(priority) do
    case Integer.parse(priority) do
      {n, ""} when n in 1..4 -> n
      _ -> 5
    end
  end

  defp priority_rank(_priority), do: 5

  defp issue_created_at_sort_key(%WorkItem{created_at: %DateTime{} = created_at}) do
    DateTime.to_unix(created_at, :microsecond)
  end

  defp issue_created_at_sort_key(%WorkItem{}), do: @max_created_at_sort_key
  defp issue_created_at_sort_key(_issue), do: @max_created_at_sort_key

  defp issue_context(%WorkItem{id: issue_id, identifier: identifier}) do
    "issue_id=#{issue_id} issue_identifier=#{identifier}"
  end
end
