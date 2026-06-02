defmodule SymphonyElixir.Tracker.Memory do
  @moduledoc """
  In-memory tracker adapter used for tests and local development.
  """

  @behaviour SymphonyElixir.Tracker

  alias SymphonyElixir.WorkItem

  @spec fetch_candidate_issues() :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_candidate_issues do
    {:ok, issue_entries()}
  end

  @spec fetch_candidate_issues(String.t()) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_candidate_issues(_workspace_id), do: fetch_candidate_issues()

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_issues_by_states(state_names) do
    normalized_states =
      state_names
      |> Enum.map(&normalize_state/1)
      |> MapSet.new()

    {:ok,
     Enum.filter(issue_entries(), fn %WorkItem{state: state} ->
       MapSet.member?(normalized_states, normalize_state(state))
     end)}
  end

  @spec fetch_issues_by_states(String.t(), [String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_issues_by_states(_workspace_id, state_names), do: fetch_issues_by_states(state_names)

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) do
    wanted_ids = MapSet.new(issue_ids)

    {:ok,
     Enum.filter(issue_entries(), fn %WorkItem{id: id} ->
       MapSet.member?(wanted_ids, id)
     end)}
  end

  @spec fetch_issue_states_by_ids(String.t(), [String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(_workspace_id, issue_ids), do: fetch_issue_states_by_ids(issue_ids)

  @spec create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(issue_id, body) do
    send_event({:memory_tracker_comment, issue_id, body})
    :ok
  end

  @spec create_comment(String.t(), String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(_workspace_id, issue_id, body), do: create_comment(issue_id, body)

  @spec update_issue_state(String.t() | WorkItem.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(%WorkItem{id: id}, state_name), do: update_issue_state(id, state_name)

  def update_issue_state(issue_id, state_name) do
    send_event({:memory_tracker_state_update, issue_id, state_name})
    :ok
  end

  @spec update_issue_state(String.t(), String.t() | WorkItem.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(_workspace_id, issue_or_id, state_name), do: update_issue_state(issue_or_id, state_name)

  defp configured_issues do
    Application.get_env(:symphony_elixir, :memory_tracker_issues, [])
  end

  defp issue_entries do
    configured_issues()
    |> Enum.map(fn
      %WorkItem{} = item -> item
      _ -> nil
    end)
    |> Enum.reject(&is_nil/1)
  end

  defp send_event(message) do
    case Application.get_env(:symphony_elixir, :memory_tracker_recipient) do
      pid when is_pid(pid) -> send(pid, message)
      _ -> :ok
    end
  end

  defp normalize_state(state) when is_binary(state) do
    state
    |> String.trim()
    |> String.downcase()
  end

  defp normalize_state(_state), do: ""
end
