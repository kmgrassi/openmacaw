defmodule SymphonyElixir.Orchestrator.WorkerHostSelector do
  @moduledoc false

  alias SymphonyElixir.{Config, Orchestrator.RepositoryRouting, Orchestrator.State, WorkItem}
  alias SymphonyElixir.Orchestrator.WorkerSlotPolicy.{Request, Slot}
  alias SymphonyElixir.Orchestrator.{WorkerSlotPolicy, WorkerSlotReservations}

  @default_runner_kinds ["codex", "openclaw", "computer_use", "manager", "planner", "local_relay"]

  @type selection_reason ::
          :no_ssh_hosts_configured
          | :no_worker_capacity
          | :preferred_worker_host_selected
          | :warm_repo_slot_selected
          | :repo_cache_miss
          | :warm_repo_slot_full
          | :runner_not_supported_on_warm_slot
          | :least_loaded_worker_host_selected

  @spec select(State.t(), String.t() | nil) :: String.t() | nil | :no_worker_capacity
  def select(%State{} = state, preferred_worker_host) do
    state
    |> select_with_reason(preferred_worker_host, nil)
    |> Map.fetch!(:worker_host)
  end

  @spec select(State.t(), String.t() | nil, WorkItem.t() | nil) ::
          String.t() | nil | :no_worker_capacity
  def select(%State{} = state, preferred_worker_host, issue) do
    state
    |> select_with_reason(preferred_worker_host, issue)
    |> Map.fetch!(:worker_host)
  end

  @spec select_with_reason(State.t(), String.t() | nil, WorkItem.t() | nil) :: %{
          worker_host: String.t() | nil | :no_worker_capacity,
          reason: selection_reason()
        }
  def select_with_reason(%State{} = state, preferred_worker_host, issue) do
    case Config.settings!().worker.ssh_hosts do
      [] ->
        %{worker_host: nil, reason: :no_ssh_hosts_configured}

      hosts ->
        available_hosts = Enum.filter(hosts, &host_slots_available?(state, &1))

        cond do
          available_hosts == [] ->
            %{worker_host: :no_worker_capacity, reason: :no_worker_capacity}

          preferred_host_available?(preferred_worker_host, available_hosts) ->
            %{worker_host: preferred_worker_host, reason: :preferred_worker_host_selected}

          true ->
            select_available_host(state, available_hosts, issue)
        end
    end
  end

  @spec select_and_reserve(State.t(), WorkItem.t(), String.t() | nil) ::
          {:ok, String.t() | nil, WorkerSlotReservations.Reservation.t() | nil}
          | {:error, :no_worker_capacity | term()}
  def select_and_reserve(%State{} = state, %WorkItem{} = issue, preferred_worker_host) do
    case Config.settings!().worker.ssh_hosts do
      [] ->
        {:ok, nil, nil}

      hosts ->
        request = request_for_issue(state, issue)

        hosts
        |> order_hosts(state, preferred_worker_host, issue)
        |> reserve_first_available(state, request)
    end
  end

  @spec host_slots_available?(State.t(), String.t()) :: boolean()
  def host_slots_available?(%State{} = state, worker_host) when is_binary(worker_host) do
    case Config.settings!().worker.max_concurrent_agents_per_host do
      limit when is_integer(limit) and limit > 0 ->
        running_host_count(state.running, worker_host) < limit

      _ ->
        true
    end
  end

  @spec running_host_count(map(), String.t()) :: non_neg_integer()
  def running_host_count(running, worker_host) when is_map(running) and is_binary(worker_host) do
    Enum.count(running, fn
      {_issue_id, %{worker_host: ^worker_host}} -> true
      _ -> false
    end)
  end

  @spec release_reservation(WorkerSlotReservations.Reservation.t() | nil) :: :ok
  def release_reservation(nil), do: :ok

  def release_reservation(%WorkerSlotReservations.Reservation{} = reservation) do
    if Process.whereis(WorkerSlotReservations) do
      WorkerSlotReservations.release(reservation)
    else
      :ok
    end
  end

  defp preferred_host_available?(preferred_worker_host, hosts)
       when is_binary(preferred_worker_host) and is_list(hosts) do
    preferred_worker_host != "" and preferred_worker_host in hosts
  end

  defp preferred_host_available?(_preferred_worker_host, _hosts), do: false

  defp least_loaded_host(%State{} = state, hosts) when is_list(hosts) do
    hosts
    |> Enum.with_index()
    |> Enum.min_by(fn {host, index} ->
      {running_host_count(state.running, host), index}
    end)
    |> elem(0)
  end

  defp order_hosts(hosts, %State{} = state, preferred_worker_host, issue) do
    hosts
    |> Enum.with_index()
    |> Enum.sort_by(fn {host, index} ->
      {host_preference_rank(state, host, preferred_worker_host, issue), running_host_count(state.running, host), index}
    end)
    |> Enum.map(&elem(&1, 0))
  end

  defp host_preference_rank(_state, host, preferred_worker_host, _issue)
       when is_binary(preferred_worker_host) and host == preferred_worker_host,
       do: 0

  defp host_preference_rank(%State{} = state, host, _preferred_worker_host, %WorkItem{} = issue) do
    supported_warm_hosts = runner_supported_warm_hosts(state, [host], issue)

    cond do
      supported_warm_hosts != [] -> 1
      host in warm_hosts_for_issue(state, issue) -> 2
      true -> 3
    end
  end

  defp host_preference_rank(_state, _host, _preferred_worker_host, _issue), do: 3

  defp reserve_first_available(hosts, %State{} = state, %Request{} = request) do
    max_sessions = Config.settings!().worker.max_concurrent_agents_per_host

    Enum.reduce_while(hosts, {:error, :no_worker_capacity}, fn host, _last_result ->
      slot = slot_for_host(state, host, max_sessions, request)

      case reserve_slot(slot, request) do
        {:ok, reservation} ->
          {:halt, {:ok, host, reservation}}

        {:error, _reason} = error ->
          {:cont, error}
      end
    end)
  end

  defp reserve_slot(%Slot{} = slot, %Request{} = request) do
    cond do
      Process.whereis(WorkerSlotReservations) ->
        WorkerSlotReservations.reserve(slot, request, self())

      WorkerSlotPolicy.reusable?(slot, request) == :ok ->
        {:ok, nil}

      true ->
        WorkerSlotPolicy.reusable?(slot, request)
    end
  end

  defp slot_for_host(%State{} = state, host, max_sessions, %Request{} = request) do
    credential_ids = active_host_values(state.running, host, :credential_id)
    resource_ids = active_host_values(state.running, host, :resource_id)

    %Slot{
      id: slot_id(host),
      workspace_id: state.workspace_id,
      customer_id: host_customer_id(state.running, host),
      execution_target: "ssh",
      runner_kinds: @default_runner_kinds,
      credential_ids: if(credential_ids == [], do: request.required_credential_ids, else: credential_ids),
      resource_ids: if(resource_ids == [], do: request.required_resource_ids, else: resource_ids),
      active_session_count: running_host_count(state.running, host),
      max_active_session_count: max_sessions
    }
  end

  defp request_for_issue(%State{} = state, %WorkItem{} = issue) do
    metadata = issue_metadata(issue)

    %Request{
      workspace_id: first_string([Map.get(metadata, "workspace_id"), Map.get(metadata, :workspace_id), state.workspace_id]),
      customer_id: first_string([Map.get(metadata, "customer_id"), Map.get(metadata, :customer_id)]),
      runner_kind:
        first_string([
          issue.runner_type,
          Map.get(metadata, "runner_kind"),
          Map.get(metadata, :runner_kind),
          Map.get(metadata, "runner_type"),
          Map.get(metadata, :runner_type)
        ]),
      required_credential_ids:
        string_list([
          Map.get(metadata, "credential_id"),
          Map.get(metadata, :credential_id),
          Map.get(metadata, "credential_ids"),
          Map.get(metadata, :credential_ids)
        ]),
      required_resource_ids:
        string_list([
          issue.repository_id,
          Map.get(metadata, "resource_id"),
          Map.get(metadata, :resource_id),
          Map.get(metadata, "resource_ids"),
          Map.get(metadata, :resource_ids)
        ])
    }
  end

  defp active_host_values(running, host, key) do
    running
    |> Enum.flat_map(fn
      {_issue_id, %{worker_host: ^host, issue: %WorkItem{} = issue}} ->
        metadata = issue_metadata(issue)

        [Map.get(metadata, Atom.to_string(key)), Map.get(metadata, key)]

      {_issue_id, %{worker_host: ^host} = running_entry} ->
        [Map.get(running_entry, key)]

      _ ->
        []
    end)
    |> string_list()
  end

  defp host_customer_id(running, host) when is_map(running) and is_binary(host) do
    running
    |> Enum.flat_map(fn
      {_issue_id, %{worker_host: ^host, issue: %WorkItem{} = issue}} ->
        metadata = issue_metadata(issue)
        [Map.get(metadata, "customer_id"), Map.get(metadata, :customer_id)]

      _ ->
        []
    end)
    |> first_string()
  end

  defp issue_metadata(%WorkItem{metadata: metadata}) when is_map(metadata), do: metadata
  defp issue_metadata(_issue), do: %{}

  defp string_list(values) when is_list(values) do
    values
    |> List.flatten()
    |> Enum.map(&normalize_string/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp string_list(value), do: string_list([value])

  defp first_string(values) when is_list(values) do
    Enum.find_value(values, &normalize_string/1)
  end

  defp first_string(value), do: first_string([value])

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(value) when is_atom(value), do: value |> Atom.to_string() |> normalize_string()
  defp normalize_string(_value), do: nil

  defp select_available_host(%State{} = state, available_hosts, %WorkItem{} = issue) do
    case warm_hosts_for_issue(state, issue) do
      [] ->
        %{
          worker_host: least_loaded_host(state, available_hosts),
          reason: :repo_cache_miss
        }

      warm_hosts ->
        available_warm_hosts = Enum.filter(warm_hosts, &(&1 in available_hosts))
        supported_warm_hosts = runner_supported_warm_hosts(state, available_warm_hosts, issue)

        cond do
          supported_warm_hosts != [] ->
            %{
              worker_host: least_loaded_host(state, supported_warm_hosts),
              reason: :warm_repo_slot_selected
            }

          available_warm_hosts != [] ->
            %{
              worker_host: least_loaded_host(state, available_hosts),
              reason: :runner_not_supported_on_warm_slot
            }

          true ->
            %{
              worker_host: least_loaded_host(state, available_hosts),
              reason: :warm_repo_slot_full
            }
        end
    end
  end

  defp select_available_host(%State{} = state, available_hosts, _issue) do
    %{
      worker_host: least_loaded_host(state, available_hosts),
      reason: :least_loaded_worker_host_selected
    }
  end

  defp warm_hosts_for_issue(%State{} = state, %WorkItem{} = issue) do
    state.running
    |> Enum.flat_map(fn
      {_issue_id, %{worker_host: worker_host, issue: %WorkItem{} = running_issue}}
      when is_binary(worker_host) ->
        if RepositoryRouting.repository_match?(running_issue, issue), do: [worker_host], else: []

      _ ->
        []
    end)
    |> Enum.uniq()
  end

  defp runner_supported_warm_hosts(%State{} = state, warm_hosts, %WorkItem{} = issue) do
    requested_runner = normalized_runner_kind(issue.runner_type)

    Enum.filter(warm_hosts, fn warm_host ->
      state.running
      |> Enum.any?(fn
        {_issue_id, %{worker_host: ^warm_host, issue: %WorkItem{} = running_issue}} ->
          RepositoryRouting.repository_match?(running_issue, issue) and
            runner_kind_supported?(running_issue.runner_type, requested_runner)

        _ ->
          false
      end)
    end)
  end

  defp runner_kind_supported?(_running_runner, nil), do: true
  defp runner_kind_supported?(nil, _requested_runner), do: true

  defp runner_kind_supported?(running_runner, requested_runner) do
    normalized_runner_kind(running_runner) == requested_runner
  end

  defp normalized_runner_kind(value) when is_binary(value) do
    value
    |> String.trim()
    |> case do
      "" -> nil
      runner -> runner
    end
  end

  defp normalized_runner_kind(_value), do: nil

  defp slot_id(host), do: "worker_host:" <> host
end
