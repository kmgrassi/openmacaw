defmodule SymphonyElixir.Orchestrator do
  @moduledoc """
  Polls Linear and dispatches repository copies to Codex-backed workers.
  """

  use GenServer
  require Logger

  alias SymphonyElixir.{AgentRunner, Config, StatusDashboard, Tracker, WorkItem}
  alias SymphonyElixir.Launcher.Server, as: LauncherServer

  alias SymphonyElixir.Orchestrator.{
    CodexState,
    DispatchPolicy,
    RepositoryRouting,
    RetryState,
    SnapshotBuilder,
    WorkerHostSelector
  }

  # Slightly above the dashboard render interval so "checking now…" can render.
  @poll_transition_render_delay_ms 20
  @empty_codex_totals %{
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: 0
  }

  defmodule State do
    @moduledoc """
    Runtime state for the orchestrator polling loop.
    """

    defstruct [
      :poll_interval_ms,
      :max_concurrent_agents,
      :workspace_id,
      :workspace_max_concurrent_agents,
      :workspace_active_agents_count,
      :workspace_cap_error,
      :next_poll_due_at_ms,
      :poll_check_in_progress,
      :tick_timer_ref,
      :tick_token,
      running: %{},
      completed: MapSet.new(),
      claimed: MapSet.new(),
      retry_attempts: %{},
      codex_totals: nil,
      codex_rate_limits: nil
    ]
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @impl true
  def init(_opts) do
    now_ms = System.monotonic_time(:millisecond)
    config = Config.settings!()

    state = %State{
      poll_interval_ms: config.polling.interval_ms,
      max_concurrent_agents: config.agent.max_concurrent_agents,
      workspace_id: Config.runtime_workspace_id(config),
      workspace_max_concurrent_agents: nil,
      workspace_active_agents_count: nil,
      workspace_cap_error: nil,
      next_poll_due_at_ms: now_ms,
      poll_check_in_progress: false,
      tick_timer_ref: nil,
      tick_token: nil,
      codex_totals: @empty_codex_totals,
      codex_rate_limits: nil
    }

    run_terminal_workspace_cleanup()
    state = schedule_tick(state, 0)

    {:ok, state}
  end

  @impl true
  def handle_info({:tick, tick_token}, %{tick_token: tick_token} = state)
      when is_reference(tick_token) do
    state = refresh_runtime_config(state)

    state = %{
      state
      | poll_check_in_progress: true,
        next_poll_due_at_ms: nil,
        tick_timer_ref: nil,
        tick_token: nil
    }

    notify_dashboard()
    :ok = schedule_poll_cycle_start()
    {:noreply, state}
  end

  def handle_info({:tick, _tick_token}, state), do: {:noreply, state}

  def handle_info(:tick, state) do
    state = refresh_runtime_config(state)

    state = %{
      state
      | poll_check_in_progress: true,
        next_poll_due_at_ms: nil,
        tick_timer_ref: nil,
        tick_token: nil
    }

    notify_dashboard()
    :ok = schedule_poll_cycle_start()
    {:noreply, state}
  end

  def handle_info(:run_poll_cycle, state) do
    state = refresh_runtime_config(state)
    state = maybe_dispatch(state)
    state = schedule_tick(state, state.poll_interval_ms)
    state = %{state | poll_check_in_progress: false}

    notify_dashboard()
    {:noreply, state}
  end

  def handle_info(
        {:DOWN, ref, :process, _pid, reason},
        %{running: running} = state
      ) do
    case find_issue_id_for_ref(running, ref) do
      nil ->
        {:noreply, state}

      issue_id ->
        {running_entry, state} = pop_running_entry(state, issue_id)
        WorkerHostSelector.release_reservation(Map.get(running_entry || %{}, :worker_slot_reservation))
        state = CodexState.record_session_completion(state, running_entry)
        session_id = running_entry_session_id(running_entry)

        state =
          case reason do
            :normal ->
              Logger.info("Agent task completed for issue_id=#{issue_id} session_id=#{session_id}; scheduling active-state continuation check")

              state
              |> complete_issue(issue_id)
              |> RetryState.schedule_issue_retry(issue_id, 1, %{
                identifier: running_entry.identifier,
                delay_type: :continuation,
                worker_host: Map.get(running_entry, :worker_host),
                workspace_path: Map.get(running_entry, :workspace_path)
              })

            _ ->
              Logger.warning("Agent task exited for issue_id=#{issue_id} session_id=#{session_id} reason=#{inspect(reason)}; scheduling retry")

              next_attempt = RetryState.next_retry_attempt_from_running(running_entry)

              RetryState.schedule_issue_retry(state, issue_id, next_attempt, %{
                identifier: running_entry.identifier,
                error: "agent exited: #{inspect(reason)}",
                worker_host: Map.get(running_entry, :worker_host),
                workspace_path: Map.get(running_entry, :workspace_path)
              })
          end

        Logger.info("Agent task finished for issue_id=#{issue_id} session_id=#{session_id} reason=#{inspect(reason)}")

        notify_dashboard()
        {:noreply, state}
    end
  end

  def handle_info({:worker_runtime_info, issue_id, runtime_info}, %{running: running} = state)
      when is_binary(issue_id) and is_map(runtime_info) do
    case Map.get(running, issue_id) do
      nil ->
        {:noreply, state}

      running_entry ->
        updated_running_entry =
          running_entry
          |> maybe_put_runtime_value(:worker_host, runtime_info[:worker_host])
          |> maybe_put_runtime_value(:workspace_path, runtime_info[:workspace_path])

        notify_dashboard()
        {:noreply, %{state | running: Map.put(running, issue_id, updated_running_entry)}}
    end
  end

  def handle_info(
        {:codex_worker_update, issue_id, %{event: _, timestamp: _} = update},
        %{running: running} = state
      ) do
    case Map.get(running, issue_id) do
      nil ->
        {:noreply, state}

      running_entry ->
        {updated_running_entry, token_delta} = CodexState.update_running_entry(running_entry, update)

        state =
          state
          |> CodexState.apply_state_token_delta(token_delta)
          |> CodexState.apply_update(update)

        notify_dashboard()
        {:noreply, %{state | running: Map.put(running, issue_id, updated_running_entry)}}
    end
  end

  def handle_info({:codex_worker_update, _issue_id, _update}, state), do: {:noreply, state}

  def handle_info({:retry_issue, issue_id, retry_token}, state) do
    result =
      case RetryState.pop_retry_attempt_state(state, issue_id, retry_token) do
        {:ok, attempt, metadata, state} ->
          RetryState.handle_retry_issue(
            state,
            issue_id,
            attempt,
            metadata,
            &release_issue_claim/2,
            &dispatch_issue/4
          )

        :missing ->
          {:noreply, state}
      end

    notify_dashboard()
    result
  end

  def handle_info({:retry_issue, _issue_id}, state), do: {:noreply, state}

  def handle_info(msg, state) do
    Logger.debug("Orchestrator ignored message: #{inspect(msg)}")
    {:noreply, state}
  end

  defp maybe_dispatch(%State{} = state) do
    state = reconcile_running_issues(state)
    available_slots = DispatchPolicy.available_slots(state)

    Logger.debug(
      "Dispatch cycle start: running=#{map_size(state.running)} claimed=#{MapSet.size(state.claimed)} available_slots=#{available_slots} workflow_cap=#{inspect(state.max_concurrent_agents)} workspace_id=#{inspect(state.workspace_id)} workspace_cap=#{inspect(state.workspace_max_concurrent_agents)} workspace_cap_error=#{inspect(state.workspace_cap_error)} pending_retries=#{map_size(state.retry_attempts)}"
    )

    with :ok <- Config.validate!(),
         {:ok, issues} <- Tracker.fetch_candidate_issues(),
         true <- available_slots > 0 do
      Logger.debug("Dispatch cycle candidate fetch: issue_count=#{length(issues)}")
      choose_issues(issues, state)
    else
      {:error, :missing_linear_api_token} ->
        Logger.error("Linear API token missing in WORKFLOW.md")
        state

      {:error, :missing_linear_project_slug} ->
        Logger.error("Linear project slug missing in WORKFLOW.md")
        state

      {:error, :missing_tracker_kind} ->
        Logger.error("Tracker kind missing in WORKFLOW.md")

        state

      {:error, {:unsupported_tracker_kind, kind}} ->
        Logger.error("Unsupported tracker kind in WORKFLOW.md: #{inspect(kind)}")

        state

      {:error, {:invalid_workflow_config, message}} ->
        Logger.error("Invalid WORKFLOW.md config: #{message}")
        state

      {:error, {:missing_workflow_file, path, reason}} ->
        Logger.error("Missing WORKFLOW.md at #{path}: #{inspect(reason)}")
        state

      {:error, :workflow_front_matter_not_a_map} ->
        Logger.error("Failed to parse WORKFLOW.md: workflow front matter must decode to a map")
        state

      {:error, {:workflow_parse_error, reason}} ->
        Logger.error("Failed to parse WORKFLOW.md: #{inspect(reason)}")
        state

      {:error, reason} ->
        Logger.error("Tracker fetch failed: #{inspect(reason)}")
        state

      false ->
        Logger.debug("Dispatch cycle skipped: no orchestrator slots available (available=#{available_slots})")
        state
    end
  end

  defp reconcile_running_issues(%State{} = state) do
    state = reconcile_stalled_running_issues(state)
    running_ids = Map.keys(state.running)

    if running_ids == [] do
      state
    else
      case Tracker.fetch_issue_states_by_ids(running_ids) do
        {:ok, issues} ->
          issues
          |> reconcile_running_issue_states(
            state,
            DispatchPolicy.active_state_set(),
            DispatchPolicy.terminal_state_set()
          )
          |> reconcile_missing_running_issue_ids(running_ids, issues)

        {:error, reason} ->
          Logger.debug("Failed to refresh running issue states: #{inspect(reason)}; keeping active workers")

          state
      end
    end
  end

  @doc false
  @spec reconcile_issue_states_for_test([WorkItem.t()], term()) :: term()
  def reconcile_issue_states_for_test(issues, %State{} = state) when is_list(issues) do
    reconcile_running_issue_states(
      issues,
      state,
      DispatchPolicy.active_state_set(),
      DispatchPolicy.terminal_state_set()
    )
  end

  def reconcile_issue_states_for_test(issues, state) when is_list(issues) do
    reconcile_running_issue_states(
      issues,
      state,
      DispatchPolicy.active_state_set(),
      DispatchPolicy.terminal_state_set()
    )
  end

  @doc false
  @spec select_worker_host_for_test(term(), String.t() | nil) :: String.t() | nil | :no_worker_capacity
  def select_worker_host_for_test(%State{} = state, preferred_worker_host) do
    select_worker_host(state, preferred_worker_host)
  end

  defp reconcile_running_issue_states([], state, _active_states, _terminal_states), do: state

  defp reconcile_running_issue_states([issue | rest], state, active_states, terminal_states) do
    reconcile_running_issue_states(
      rest,
      reconcile_issue_state(issue, state, active_states, terminal_states),
      active_states,
      terminal_states
    )
  end

  defp reconcile_issue_state(%WorkItem{} = issue, state, active_states, terminal_states) do
    cond do
      DispatchPolicy.terminal_issue_state?(issue.state, terminal_states) ->
        Logger.info("Issue moved to terminal state: #{issue_context(issue)} state=#{issue.state}; stopping active agent")

        terminate_running_issue(state, issue.id, true)

      !DispatchPolicy.issue_routable_to_worker?(issue) ->
        Logger.info("Issue no longer routed to this worker: #{issue_context(issue)} assignee=#{inspect(issue.metadata[:assignee_id])}; stopping active agent")

        terminate_running_issue(state, issue.id, false)

      DispatchPolicy.active_issue_state?(issue.state, active_states) ->
        refresh_running_issue_state(state, issue)

      true ->
        Logger.info("Issue moved to non-active state: #{issue_context(issue)} state=#{issue.state}; stopping active agent")

        terminate_running_issue(state, issue.id, false)
    end
  end

  defp reconcile_issue_state(_issue, state, _active_states, _terminal_states), do: state

  defp reconcile_missing_running_issue_ids(%State{} = state, requested_issue_ids, issues)
       when is_list(requested_issue_ids) and is_list(issues) do
    visible_issue_ids =
      issues
      |> Enum.flat_map(fn
        %WorkItem{id: issue_id} when is_binary(issue_id) -> [issue_id]
        _ -> []
      end)
      |> MapSet.new()

    Enum.reduce(requested_issue_ids, state, fn issue_id, state_acc ->
      if MapSet.member?(visible_issue_ids, issue_id) do
        state_acc
      else
        log_missing_running_issue(state_acc, issue_id)
        terminate_running_issue(state_acc, issue_id, false)
      end
    end)
  end

  defp reconcile_missing_running_issue_ids(state, _requested_issue_ids, _issues), do: state

  defp log_missing_running_issue(%State{} = state, issue_id) when is_binary(issue_id) do
    case Map.get(state.running, issue_id) do
      %{identifier: identifier} ->
        Logger.info("Issue no longer visible during running-state refresh: issue_id=#{issue_id} issue_identifier=#{identifier}; stopping active agent")

      _ ->
        Logger.info("Issue no longer visible during running-state refresh: issue_id=#{issue_id}; stopping active agent")
    end
  end

  defp log_missing_running_issue(_state, _issue_id), do: :ok

  defp refresh_running_issue_state(%State{} = state, %WorkItem{} = issue) do
    case Map.get(state.running, issue.id) do
      %{issue: %WorkItem{} = existing_issue} = running_entry ->
        merged_issue = merge_running_issue(existing_issue, issue)
        %{state | running: Map.put(state.running, issue.id, %{running_entry | issue: merged_issue})}

      _ ->
        state
    end
  end

  defp merge_running_issue(%WorkItem{} = existing_issue, %WorkItem{} = refreshed_issue) do
    existing = Map.from_struct(existing_issue)
    refreshed = Map.from_struct(refreshed_issue)

    refreshed
    |> Enum.reduce(existing, fn {key, value}, acc ->
      Map.put(acc, key, merge_running_issue_field(Map.get(acc, key), value))
    end)
    |> then(&struct(WorkItem, &1))
  end

  defp merge_running_issue_field(existing, nil), do: existing
  defp merge_running_issue_field(existing, ""), do: existing
  defp merge_running_issue_field(existing, []), do: existing
  defp merge_running_issue_field(existing, value) when is_map(value) and map_size(value) == 0, do: existing
  defp merge_running_issue_field(_existing, value), do: value

  defp terminate_running_issue(%State{} = state, issue_id, cleanup_workspace) do
    case Map.get(state.running, issue_id) do
      nil ->
        release_issue_claim(state, issue_id)

      %{pid: pid, ref: ref, identifier: identifier} = running_entry ->
        state = CodexState.record_session_completion(state, running_entry)
        worker_host = Map.get(running_entry, :worker_host)
        WorkerHostSelector.release_reservation(Map.get(running_entry, :worker_slot_reservation))

        if cleanup_workspace do
          RetryState.cleanup_issue_workspace(identifier, worker_host)
        end

        if is_pid(pid) do
          terminate_task(pid)
        end

        if is_reference(ref) do
          Process.demonitor(ref, [:flush])
        end

        %{
          state
          | running: Map.delete(state.running, issue_id),
            claimed: MapSet.delete(state.claimed, issue_id),
            retry_attempts: Map.delete(state.retry_attempts, issue_id)
        }

      _ ->
        release_issue_claim(state, issue_id)
    end
  end

  defp reconcile_stalled_running_issues(%State{} = state) do
    timeout_ms = Config.settings!().codex.stall_timeout_ms

    cond do
      timeout_ms <= 0 ->
        state

      map_size(state.running) == 0 ->
        state

      true ->
        now = DateTime.utc_now()

        Enum.reduce(state.running, state, fn {issue_id, running_entry}, state_acc ->
          restart_stalled_issue(state_acc, issue_id, running_entry, now, timeout_ms)
        end)
    end
  end

  defp restart_stalled_issue(state, issue_id, running_entry, now, timeout_ms) do
    elapsed_ms = stall_elapsed_ms(running_entry, now)

    if is_integer(elapsed_ms) and elapsed_ms > timeout_ms do
      identifier = Map.get(running_entry, :identifier, issue_id)
      session_id = running_entry_session_id(running_entry)

      Logger.warning("Issue stalled: issue_id=#{issue_id} issue_identifier=#{identifier} session_id=#{session_id} elapsed_ms=#{elapsed_ms}; restarting with backoff")

      next_attempt = RetryState.next_retry_attempt_from_running(running_entry)

      state
      |> terminate_running_issue(issue_id, false)
      |> RetryState.schedule_issue_retry(issue_id, next_attempt, %{
        identifier: identifier,
        error: "stalled for #{elapsed_ms}ms without codex activity"
      })
    else
      state
    end
  end

  defp stall_elapsed_ms(running_entry, now) do
    running_entry
    |> last_activity_timestamp()
    |> case do
      %DateTime{} = timestamp ->
        max(0, DateTime.diff(now, timestamp, :millisecond))

      _ ->
        nil
    end
  end

  defp last_activity_timestamp(running_entry) when is_map(running_entry) do
    Map.get(running_entry, :last_codex_timestamp) || Map.get(running_entry, :started_at)
  end

  defp last_activity_timestamp(_running_entry), do: nil

  defp terminate_task(pid) when is_pid(pid) do
    case Task.Supervisor.terminate_child(SymphonyElixir.TaskSupervisor, pid) do
      :ok ->
        :ok

      {:error, :not_found} ->
        Process.exit(pid, :shutdown)
    end
  end

  defp terminate_task(_pid), do: :ok

  defp choose_issues(issues, state) do
    active_states = DispatchPolicy.active_state_set()
    terminal_states = DispatchPolicy.terminal_state_set()
    total = length(issues)

    issues
    |> DispatchPolicy.sort_issues_for_dispatch()
    |> Enum.with_index(1)
    |> Enum.reduce(state, fn {issue, index}, state_acc ->
      Logger.debug("Queue check #{index}/#{total}: #{issue_context(issue)}")

      choose_issue(issue, state_acc, active_states, terminal_states, index, total)
    end)
  end

  defp choose_issue(%WorkItem{} = issue, %State{} = state, active_states, terminal_states, index, total) do
    cond do
      !DispatchPolicy.candidate_issue?(issue, active_states, terminal_states) ->
        Logger.debug("Queue check #{index}/#{total}: dispatch blocked #{issue_context(issue)}")
        state

      repository_skipped?(issue) ->
        skip_repository_mismatch(state, issue)

      should_dispatch_issue?(issue, state, active_states, terminal_states) ->
        Logger.debug("Queue check #{index}/#{total}: dispatch allowed #{issue_context(issue)}")
        dispatch_issue(state, issue)

      true ->
        skip_reason = DispatchPolicy.capacity_skip_reason(issue, state)

        Logger.debug("Queue check #{index}/#{total}: dispatch blocked #{issue_context(issue)} skip_reason=#{inspect(skip_reason)}")

        state
    end
  end

  defp choose_issue(_issue, state, _active_states, _terminal_states, index, total) do
    Logger.debug("Queue check #{index}/#{total}: dispatch blocked non-work-item")
    state
  end

  defp should_dispatch_issue?(%WorkItem{} = issue, %State{} = state, active_states, terminal_states) do
    DispatchPolicy.dispatch_eligible?(issue, state, active_states, terminal_states) and
      worker_slots_available?(state, issue)
  end

  defp should_dispatch_issue?(_issue, _state, _active_states, _terminal_states), do: false

  defp repository_skipped?(%WorkItem{} = issue) do
    match?({:skip, _repository}, RepositoryRouting.dispatch_decision(issue))
  end

  defp skip_repository_mismatch(%State{} = state, %WorkItem{} = issue) do
    {:skip, repository} = RepositoryRouting.dispatch_decision(issue)

    Logger.debug(
      "Skipping issue for different repository: #{issue_context(issue)} repository=#{inspect(repository)} configured_repository=#{inspect(RepositoryRouting.configured_repository(Config.settings!()))}"
    )

    state
  end

  defp dispatch_issue(%State{} = state, issue, attempt \\ nil, preferred_worker_host \\ nil) do
    case DispatchPolicy.revalidate_issue_for_dispatch(
           issue,
           &Tracker.fetch_issue_states_by_ids/1,
           DispatchPolicy.terminal_state_set()
         ) do
      {:ok, %WorkItem{} = refreshed_issue} ->
        do_dispatch_issue(state, refreshed_issue, attempt, preferred_worker_host)

      {:skip, :missing} ->
        Logger.info("Skipping dispatch; issue no longer active or visible: #{issue_context(issue)}")
        state

      {:skip, %WorkItem{} = refreshed_issue} ->
        blockers = Map.get(refreshed_issue.metadata, :blocked_by, [])
        Logger.info("Skipping stale dispatch after issue refresh: #{issue_context(refreshed_issue)} state=#{inspect(refreshed_issue.state)} blocked_by=#{length(blockers)}")

        state

      {:error, reason} ->
        Logger.warning("Skipping dispatch; issue refresh failed for #{issue_context(issue)}: #{inspect(reason)}")
        state
    end
  end

  defp do_dispatch_issue(%State{} = state, issue, attempt, preferred_worker_host) do
    recipient = self()

    case select_worker_host_reservation(state, issue, preferred_worker_host) do
      {:error, :no_worker_capacity} ->
        Logger.debug("No SSH worker slots available for #{issue_context(issue)} preferred_worker_host=#{inspect(preferred_worker_host)}")
        state

      {:error, reason} ->
        Logger.debug("No reusable worker slot available for #{issue_context(issue)} preferred_worker_host=#{inspect(preferred_worker_host)} reason=#{inspect(reason)}")
        state

      {:ok, worker_host, reservation} ->
        spawn_issue_on_worker_host(state, issue, attempt, recipient, worker_host, reservation)
    end
  end

  defp spawn_issue_on_worker_host(%State{} = state, issue, attempt, recipient, worker_host, reservation) do
    case Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
           AgentRunner.run(issue, recipient, attempt: attempt, worker_host: worker_host)
         end) do
      {:ok, pid} ->
        ref = Process.monitor(pid)

        Logger.info("Dispatching issue to agent: #{issue_context(issue)} pid=#{inspect(pid)} attempt=#{inspect(attempt)} worker_host=#{worker_host || "local"}")

        running =
          Map.put(state.running, issue.id, %{
            pid: pid,
            ref: ref,
            identifier: issue.identifier,
            issue: issue,
            worker_host: worker_host,
            worker_slot_reservation: reservation,
            workspace_path: nil,
            session_id: nil,
            last_codex_message: nil,
            last_codex_timestamp: nil,
            last_codex_event: nil,
            codex_app_server_pid: nil,
            codex_input_tokens: 0,
            codex_output_tokens: 0,
            codex_total_tokens: 0,
            codex_last_reported_input_tokens: 0,
            codex_last_reported_output_tokens: 0,
            codex_last_reported_total_tokens: 0,
            turn_count: 0,
            retry_attempt: RetryState.normalize_retry_attempt(attempt),
            started_at: DateTime.utc_now()
          })

        %{
          state
          | running: running,
            claimed: MapSet.put(state.claimed, issue.id),
            retry_attempts: Map.delete(state.retry_attempts, issue.id)
        }

      {:error, reason} ->
        WorkerHostSelector.release_reservation(reservation)
        Logger.error("Unable to spawn agent for #{issue_context(issue)}: #{inspect(reason)}")
        next_attempt = if is_integer(attempt), do: attempt + 1, else: nil

        RetryState.schedule_issue_retry(state, issue.id, next_attempt, %{
          identifier: issue.identifier,
          error: "failed to spawn agent: #{inspect(reason)}",
          worker_host: worker_host
        })
    end
  end

  defp complete_issue(%State{} = state, issue_id) do
    %{
      state
      | completed: MapSet.put(state.completed, issue_id),
        retry_attempts: Map.delete(state.retry_attempts, issue_id)
    }
  end

  defp run_terminal_workspace_cleanup do
    case Tracker.fetch_issues_by_states(Config.settings!().tracker.terminal_states) do
      {:ok, issues} ->
        issues
        |> Enum.each(fn
          %WorkItem{identifier: identifier} when is_binary(identifier) ->
            RetryState.cleanup_issue_workspace(identifier)

          _ ->
            :ok
        end)

      {:error, reason} ->
        Logger.warning("Skipping startup terminal workspace cleanup; failed to fetch terminal issues: #{inspect(reason)}")
    end
  end

  defp notify_dashboard do
    StatusDashboard.notify_update()
  end

  defp release_issue_claim(%State{} = state, issue_id) do
    %{state | claimed: MapSet.delete(state.claimed, issue_id)}
  end

  defp maybe_put_runtime_value(running_entry, _key, nil), do: running_entry

  defp maybe_put_runtime_value(running_entry, key, value) when is_map(running_entry) do
    Map.put(running_entry, key, value)
  end

  defp select_worker_host(%State{} = state, preferred_worker_host, issue \\ nil) do
    hosts = Config.settings!().worker.ssh_hosts
    selection = WorkerHostSelector.select_with_reason(state, preferred_worker_host, issue)

    case selection.worker_host do
      nil when hosts == [] ->
        Logger.debug("Worker host selection: no ssh hosts configured, using local execution for #{issue_context_for_queue(state)}")
        nil

      :no_worker_capacity ->
        Logger.debug("Worker host selection: no worker host has capacity; configured_hosts=#{inspect(hosts)}")
        :no_worker_capacity

      ^preferred_worker_host = host when is_binary(host) ->
        Logger.debug("Worker host selection: using preferred host=#{preferred_worker_host} reason=#{selection.reason}")
        host

      host ->
        Logger.debug("Worker host selection: selected host=#{host} reason=#{selection.reason} from configured_hosts=#{inspect(hosts)}")
        host
    end
  end

  defp select_worker_host_reservation(%State{} = state, %WorkItem{} = issue, preferred_worker_host) do
    hosts = Config.settings!().worker.ssh_hosts

    case WorkerHostSelector.select_and_reserve(state, issue, preferred_worker_host) do
      {:ok, nil, nil} when hosts == [] ->
        Logger.debug("Worker host selection: no ssh hosts configured, using local execution for #{issue_context_for_queue(state)}")
        {:ok, nil, nil}

      {:error, :no_worker_capacity} ->
        Logger.debug("Worker host selection: no worker host has reusable capacity; configured_hosts=#{inspect(hosts)}")
        {:error, :no_worker_capacity}

      {:error, reason} ->
        Logger.debug("Worker host selection: no worker host passed reuse policy; configured_hosts=#{inspect(hosts)} reason=#{inspect(reason)}")
        {:error, reason}

      {:ok, ^preferred_worker_host = host, reservation} when is_binary(host) ->
        Logger.debug("Worker host selection: using reserved preferred host=#{preferred_worker_host}")
        {:ok, host, reservation}

      {:ok, host, reservation} ->
        Logger.debug("Worker host selection: reserved host=#{host} from configured_hosts=#{inspect(hosts)}")
        {:ok, host, reservation}
    end
  end

  defp worker_slots_available?(%State{} = state, issue) do
    select_worker_host(state, nil, issue) != :no_worker_capacity
  end

  defp issue_context_for_queue(%State{} = state) do
    "running=#{map_size(state.running)} claimed=#{MapSet.size(state.claimed)}"
  end

  defp find_issue_id_for_ref(running, ref) do
    running
    |> Enum.find_value(fn {issue_id, %{ref: running_ref}} ->
      if running_ref == ref, do: issue_id
    end)
  end

  defp running_entry_session_id(%{session_id: session_id}) when is_binary(session_id),
    do: session_id

  defp running_entry_session_id(_running_entry), do: "n/a"

  defp issue_context(%WorkItem{id: issue_id, identifier: identifier}) do
    "issue_id=#{issue_id} issue_identifier=#{identifier}"
  end

  @spec request_refresh() :: map() | :unavailable
  def request_refresh do
    request_refresh(__MODULE__)
  end

  @spec request_refresh(GenServer.server()) :: map() | :unavailable
  def request_refresh(server) do
    if process_available?(server) do
      GenServer.call(server, :request_refresh)
    else
      :unavailable
    end
  end

  @spec snapshot() :: map() | :timeout | :unavailable
  def snapshot, do: snapshot(__MODULE__, 15_000)

  @spec snapshot(GenServer.server(), timeout()) :: map() | :timeout | :unavailable
  def snapshot(server, timeout) do
    if process_available?(server) do
      try do
        GenServer.call(server, :snapshot, timeout)
      catch
        :exit, {:timeout, _} -> :timeout
        :exit, _ -> :unavailable
      end
    else
      :unavailable
    end
  end

  defp process_available?(server) when is_pid(server), do: Process.alive?(server)
  defp process_available?(server), do: not is_nil(Process.whereis(server))

  @impl true
  def handle_call(:snapshot, _from, state) do
    state = refresh_runtime_config(state)
    {:reply, SnapshotBuilder.build(state), state}
  end

  def handle_call(:request_refresh, _from, state) do
    now_ms = System.monotonic_time(:millisecond)
    already_due? = is_integer(state.next_poll_due_at_ms) and state.next_poll_due_at_ms <= now_ms
    coalesced = state.poll_check_in_progress == true or already_due?
    state = if coalesced, do: state, else: schedule_tick(state, 0)

    {:reply,
     %{
       queued: true,
       coalesced: coalesced,
       requested_at: DateTime.utc_now(),
       operations: ["poll", "reconcile"]
     }, state}
  end

  defp schedule_tick(%State{} = state, delay_ms) when is_integer(delay_ms) and delay_ms >= 0 do
    if is_reference(state.tick_timer_ref) do
      Process.cancel_timer(state.tick_timer_ref)
    end

    tick_token = make_ref()
    timer_ref = Process.send_after(self(), {:tick, tick_token}, delay_ms)

    %{
      state
      | tick_timer_ref: timer_ref,
        tick_token: tick_token,
        next_poll_due_at_ms: System.monotonic_time(:millisecond) + delay_ms
    }
  end

  defp schedule_poll_cycle_start do
    :timer.send_after(@poll_transition_render_delay_ms, self(), :run_poll_cycle)
    :ok
  end

  defp pop_running_entry(state, issue_id) do
    {Map.get(state.running, issue_id), %{state | running: Map.delete(state.running, issue_id)}}
  end

  defp refresh_runtime_config(%State{} = state) do
    config = Config.settings!()
    workspace_id = Config.runtime_workspace_id(config)

    {workspace_max_concurrent_agents, workspace_active_agents_count, workspace_cap_error} =
      resolve_workspace_capacity(workspace_id, state)

    %{
      state
      | poll_interval_ms: config.polling.interval_ms,
        max_concurrent_agents: config.agent.max_concurrent_agents,
        workspace_id: workspace_id,
        workspace_max_concurrent_agents: workspace_max_concurrent_agents,
        workspace_active_agents_count: workspace_active_agents_count,
        workspace_cap_error: workspace_cap_error
    }
  end

  defp resolve_workspace_capacity(workspace_id, state)
       when is_binary(workspace_id) and workspace_id != "" do
    case Config.workspace_max_concurrent_agents(workspace_id) do
      {:ok, cap} when is_integer(cap) and cap > 0 ->
        case workspace_active_agents_count(workspace_id, state) do
          {:ok, count} ->
            {cap, count, nil}

          {:error, reason} ->
            Logger.warning("Workspace active count unavailable; dispatch will remain queued workspace_id=#{workspace_id} reason=#{inspect(reason)}")

            {cap, nil, reason}
        end

      {:error, reason} ->
        Logger.warning("Workspace capacity unavailable; dispatch will remain queued workspace_id=#{workspace_id} reason=#{inspect(reason)}")

        {0, nil, reason}
    end
  end

  defp resolve_workspace_capacity(_workspace_id, _state), do: {nil, nil, nil}

  defp workspace_active_agents_count(workspace_id, %State{} = state) do
    if Process.whereis(LauncherServer) do
      case LauncherServer.workspace_active_agents_count(workspace_id, exclude_pid: self()) do
        {:ok, count} -> {:ok, count + map_size(state.running)}
        {:error, reason} -> {:error, reason}
      end
    else
      {:ok, map_size(state.running)}
    end
  end
end
