defmodule SymphonyElixir.Orchestrator.RepositoryRouting do
  @moduledoc """
  Repository-aware dispatch checks for the orchestrator polling loop.

  The runtime owns dispatch safety. When a work item names a repository, this
  orchestrator may only run it if the launched worker configuration names the
  same repository. Local mismatches are skipped so another repo-specific
  orchestrator can claim the item. Untargeted work items keep the existing
  routing behavior.
  """

  alias SymphonyElixir.{Config, WorkItem}

  @type decision :: :routable | {:skip, String.t()}

  @spec dispatch_decision(WorkItem.t()) :: decision()
  def dispatch_decision(%WorkItem{} = issue) do
    dispatch_decision(issue, Config.settings!())
  end

  @spec dispatch_decision(WorkItem.t(), map()) :: decision()
  def dispatch_decision(%WorkItem{} = issue, settings) do
    issue_repositories = work_item_repositories(issue)

    case issue_repositories do
      [] ->
        :routable

      repositories ->
        if repository_values_overlap?(repositories, configured_repositories(settings)) do
          :routable
        else
          {:skip, Enum.join(repositories, ",")}
        end
    end
  end

  @spec work_item_repository(WorkItem.t()) :: String.t() | nil
  def work_item_repository(%WorkItem{} = issue) do
    issue
    |> work_item_repositories()
    |> List.first()
  end

  @spec work_item_repositories(WorkItem.t()) :: [String.t()]
  def work_item_repositories(%WorkItem{} = issue) do
    unique_strings([
      issue.repository_id,
      issue.repository,
      get_in(issue.metadata, ["repository_id"]),
      get_in(issue.metadata, [:repository_id]),
      get_in(issue.metadata, ["repo_id"]),
      get_in(issue.metadata, [:repo_id]),
      get_in(issue.metadata, ["repository"]),
      get_in(issue.metadata, [:repository])
    ])
  end

  @spec repository_match?(WorkItem.t(), WorkItem.t()) :: boolean()
  def repository_match?(%WorkItem{} = left, %WorkItem{} = right) do
    repository_match?(work_item_repositories(left), work_item_repositories(right))
  end

  @spec repository_match?([String.t()], [String.t()]) :: boolean()
  def repository_match?(left_repositories, right_repositories)
      when is_list(left_repositories) and is_list(right_repositories) do
    repository_values_overlap?(left_repositories, right_repositories)
  end

  @spec configured_repository(map()) :: String.t() | nil
  def configured_repository(%{workspace: workspace, tracker: tracker}) do
    %{workspace: workspace, tracker: tracker}
    |> configured_repositories()
    |> List.first()
  end

  def configured_repository(_settings), do: nil

  @spec configured_repositories(map()) :: [String.t()]
  def configured_repositories(%{workspace: workspace, tracker: tracker}) do
    unique_strings([
      Map.get(workspace, :repository),
      Map.get(workspace, "repository"),
      Map.get(tracker, :repository),
      Map.get(tracker, "repository")
    ])
  end

  def configured_repositories(_settings), do: []

  defp repository_values_overlap?(_issue_repositories, []), do: false

  defp repository_values_overlap?(issue_repositories, configured_repositories) do
    issue_values = comparable_repository_values(issue_repositories)
    configured_values = comparable_repository_values(configured_repositories)

    Enum.any?(issue_values, &MapSet.member?(configured_values, &1))
  end

  defp comparable_repository_values(repositories) do
    repositories
    |> Enum.flat_map(fn repository ->
      [repository, github_slug(repository)]
    end)
    |> unique_strings()
    |> MapSet.new()
  end

  defp github_slug(repository) when is_binary(repository) do
    case URI.parse(repository) do
      %URI{host: host, path: path} when host in ["github.com", "www.github.com"] and is_binary(path) ->
        path
        |> String.trim_leading("/")
        |> String.trim_trailing(".git")
        |> normalize_string()

      _ ->
        nil
    end
  end

  defp github_slug(_repository), do: nil

  defp unique_strings(values) when is_list(values) do
    values
    |> Enum.map(&normalize_string/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(_value), do: nil
end
