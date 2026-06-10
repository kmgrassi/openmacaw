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
  alias SymphonyElixir.Manager.SchedulerConfig
  alias SymphonyElixir.Orchestrator.State
  alias SymphonyElixir.Orchestrator.IntentVocabulary
  alias SymphonyElixir.Schema.ExecutionProfile

  @max_created_at_sort_key 9_223_372_036_854_775_807

  @spec dispatch_eligible?(WorkItem.t(), State.t()) :: boolean()
  def dispatch_eligible?(%WorkItem{} = issue, %State{} = state) do
    dispatch_eligible?(issue, state, active_state_set(), terminal_state_set())
  end

  @spec dispatch_summary_for_row(map()) :: map()
  def dispatch_summary_for_row(row) when is_map(row) do
    reason = dispatch_summary_reason(row)
    runner_kind = row_runner_kind(row)

    %{
      "eligible" => reason == "ready",
      "reason" => reason,
      "blocked_by" => dispatch_blockers(row),
      "runner_kind" => runner_kind,
      "repository" => row_repository(row),
      "expected_pickup" => expected_pickup_summary(row, reason)
    }
    |> maybe_put_summary_value("intent", row_intent(row))
  end

  def dispatch_summary_for_row(_row) do
    %{
      "eligible" => false,
      "reason" => "invalid_for_orchestrator",
      "blocked_by" => [],
      "runner_kind" => nil,
      "intent" => nil,
      "repository" => nil,
      "expected_pickup" => expected_pickup_summary(%{}, "invalid_for_orchestrator")
    }
  end

  @spec resolve_runner_kind(map()) :: String.t() | nil
  def resolve_runner_kind(row) when is_map(row), do: row_runner_kind(row)
  def resolve_runner_kind(_row), do: nil

  @spec runner_kind_for_intent(String.t() | nil, map()) :: String.t() | nil
  def runner_kind_for_intent(intent, row \\ %{})

  def runner_kind_for_intent(intent, row) when is_binary(intent) and is_map(row) do
    intent = normalize_dispatch_token(intent)
    location = row_execution_location(row)

    cond do
      location == "local" and intent in ["implement", "remediate", "review", "test"] ->
        supported_runner_kind_or_nil("local_model_coding")

      true ->
        intent
        |> IntentVocabulary.runner_kind_for_intent()
        |> supported_runner_kind_or_nil()
    end
  end

  def runner_kind_for_intent(_intent, _row), do: nil

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

  defp expected_pickup_summary(row, "ready") do
    cadence_ms = SchedulerConfig.default_min_cadence_ms()

    if manager_runnable_row?(row) do
      %{
        "status" => "eligible",
        "message" => "eligible at next manager tick (~#{ceil(cadence_ms / 1000)}s)",
        "eligible_at" => row_next_poll_at(row),
        "cadence_ms" => cadence_ms,
        "failed_gates" => []
      }
    else
      %{
        "status" => "planned",
        "message" => "not manager-runnable: #{manager_not_runnable_message(row)}",
        "eligible_at" => row_next_poll_at(row),
        "cadence_ms" => cadence_ms,
        "failed_gates" => manager_pickup_failed_gates(row)
      }
    end
  end

  defp expected_pickup_summary(row, "blocked_by_dependencies") do
    blockers = dispatch_blockers(row)

    %{
      "status" => "blocked",
      "message" => "blocked: depends_on #{Enum.join(blockers, ", ")} unresolved",
      "eligible_at" => nil,
      "cadence_ms" => SchedulerConfig.default_min_cadence_ms(),
      "failed_gates" => ["dependencies"]
    }
  end

  defp expected_pickup_summary(row, "waiting_until_next_poll_at") do
    next_poll_at = row_next_poll_at(row)

    %{
      "status" => "waiting",
      "message" => "eligible after next_poll_at #{next_poll_at}",
      "eligible_at" => next_poll_at,
      "cadence_ms" => SchedulerConfig.default_min_cadence_ms(),
      "failed_gates" => ["next_poll_at"]
    }
  end

  defp expected_pickup_summary(row, "missing_route") do
    %{
      "status" => "blocked",
      "message" => "blocked: no runner_kind resolved for dispatch",
      "eligible_at" => row_next_poll_at(row),
      "cadence_ms" => SchedulerConfig.default_min_cadence_ms(),
      "failed_gates" => ["runner_kind"]
    }
  end

  defp expected_pickup_summary(row, "draft_or_paused") do
    %{
      "status" => "blocked",
      "message" => "not manager-runnable: state=#{row_state(row)}",
      "eligible_at" => row_next_poll_at(row),
      "cadence_ms" => SchedulerConfig.default_min_cadence_ms(),
      "failed_gates" => ["state"]
    }
  end

  defp expected_pickup_summary(row, _reason) do
    %{
      "status" => "blocked",
      "message" => "not manager-runnable: invalid work item shape",
      "eligible_at" => row_next_poll_at(row),
      "cadence_ms" => SchedulerConfig.default_min_cadence_ms(),
      "failed_gates" => ["shape"]
    }
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

  defp manager_runnable_row?(row) do
    manager_due_state?(row) and manager_next_poll_due?(row)
  end

  defp manager_due_state?(row) do
    row
    |> row_state()
    |> normalize_issue_state()
    |> then(&(&1 in SchedulerConfig.default_due_task_query().states))
  end

  defp manager_next_poll_due?(row) do
    case row_next_poll_at(row) do
      nil ->
        false

      next_poll_at ->
        case DateTime.from_iso8601(next_poll_at) do
          {:ok, datetime, _offset} -> DateTime.compare(datetime, DateTime.utc_now()) != :gt
          {:error, _reason} -> false
        end
    end
  end

  defp manager_not_runnable_message(row) do
    row
    |> manager_pickup_failed_gates()
    |> Enum.map(fn
      "manager_state" -> "state=#{row_state(row)}"
      "next_poll_at" -> "next_poll_at not set or not due"
      gate -> gate
    end)
    |> Enum.join(", ")
  end

  defp manager_pickup_failed_gates(row) do
    []
    |> maybe_append_failed_gate("manager_state", !manager_due_state?(row))
    |> maybe_append_failed_gate("next_poll_at", !manager_next_poll_due?(row))
  end

  defp maybe_append_failed_gate(gates, gate, true), do: gates ++ [gate]
  defp maybe_append_failed_gate(gates, _gate, false), do: gates

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

    explicit_runner_kind(row, metadata, routing) ||
      row
      |> row_intent()
      |> runner_kind_for_intent(row)
  end

  defp explicit_runner_kind(row, metadata, routing) do
    [
      Map.get(row, "runner_kind"),
      Map.get(metadata, "runner_kind"),
      Map.get(metadata, :runner_kind),
      Map.get(routing, "runner_kind"),
      Map.get(routing, :runner_kind)
    ]
    |> Enum.find(&present_string?/1)
    |> supported_runner_kind_or_nil()
  end

  defp row_intent(row) do
    metadata = row_metadata(row)
    routing = row_routing(row)

    [
      Map.get(row, "intent"),
      Map.get(metadata, "intent"),
      Map.get(metadata, :intent),
      Map.get(routing, "intent"),
      Map.get(routing, :intent)
    ]
    |> Enum.find(&present_string?/1)
    |> normalize_dispatch_token()
  end

  defp row_execution_location(row) do
    row
    |> row_routing()
    |> then(&(Map.get(&1, "execution_location") || Map.get(&1, :execution_location)))
    |> normalize_dispatch_token()
  end

  defp row_repository(row) do
    metadata = row_metadata(row)

    Map.get(row, "repository") ||
      Map.get(metadata, "repository") ||
      Map.get(metadata, "repository_id")
  end

  defp row_state(row), do: Map.get(row, "state") || Map.get(row, "status") || ""

  defp row_next_poll_at(row) do
    case Map.get(row, "next_poll_at") do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

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

  defp supported_runner_kind_or_nil(runner_kind) when is_binary(runner_kind) do
    if runner_kind in ExecutionProfile.supported_runner_kinds(), do: runner_kind
  end

  defp supported_runner_kind_or_nil(_runner_kind), do: nil

  defp normalize_dispatch_token(value) when is_binary(value) do
    value
    |> String.trim()
    |> String.downcase()
    |> String.replace(~r/[\s-]+/, "_")
    |> case do
      "" -> nil
      normalized -> normalized
    end
  end

  defp normalize_dispatch_token(_value), do: nil

  defp non_empty_list?(value), do: is_list(value) and value != []

  defp maybe_put_summary_value(summary, _key, nil), do: summary
  defp maybe_put_summary_value(summary, key, value), do: Map.put(summary, key, value)

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
