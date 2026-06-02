defmodule SymphonyElixir.Tracker.GitHub do
  @moduledoc """
  Tracker adapter for GitHub Issues.

  Polls the GitHub Issues API for issues matching active states and maps them
  to `WorkItem` structs.

  ## Configuration

      tracker:
        kind: github
        repository: "org/repo"
        api_key: $GITHUB_TOKEN
        active_states: [open]
        terminal_states: [closed]
        webhook_secret: $GITHUB_WEBHOOK_SECRET

  ## State mapping

  GitHub issues have two native states: `open` and `closed`. For more granular
  state tracking, the adapter uses labels prefixed with `status:` (e.g.,
  `status:in-progress`, `status:review`).
  """

  @behaviour SymphonyElixir.Tracker

  alias SymphonyElixir.Config
  alias SymphonyElixir.WorkItem
  alias SymphonyElixir.WorkItem.Mapper, as: WorkItemMapper

  @github_api "https://api.github.com"

  def fetch_candidate_issues do
    config = tracker_config()
    {owner, repo} = parse_repository(config.repository)

    case fetch_all_pages(owner, repo, "open", config) do
      {:ok, issues} ->
        work_items =
          issues
          |> reject_pull_requests()
          |> Enum.map(&WorkItemMapper.from_github_issue(owner, repo, &1))

        {:ok, filter_by_active_states(work_items, config.active_states)}

      {:error, _} = err ->
        err
    end
  end

  @impl true
  def fetch_candidate_issues(_workspace_id), do: fetch_candidate_issues()

  def fetch_issues_by_states(state_names) do
    config = tracker_config()
    {owner, repo} = parse_repository(config.repository)

    github_states = Enum.uniq(Enum.map(state_names, &to_github_state/1))

    results =
      Enum.reduce_while(github_states, {:ok, []}, fn gh_state, {:ok, acc} ->
        case fetch_all_pages(owner, repo, gh_state, config) do
          {:ok, issues} -> {:cont, {:ok, acc ++ issues}}
          {:error, _} = err -> {:halt, err}
        end
      end)

    case results do
      {:ok, issues} ->
        work_items =
          issues
          |> reject_pull_requests()
          |> Enum.map(&WorkItemMapper.from_github_issue(owner, repo, &1))

        {:ok, filter_by_label_states(work_items, state_names)}

      {:error, _} = err ->
        err
    end
  end

  @impl true
  def fetch_issues_by_states(_workspace_id, state_names), do: fetch_issues_by_states(state_names)

  def fetch_issue_states_by_ids(issue_ids) do
    config = tracker_config()
    {owner, repo} = parse_repository(config.repository)

    results =
      Enum.reduce_while(issue_ids, {:ok, []}, fn issue_id, {:ok, acc} ->
        number = extract_issue_number(issue_id)
        url = "#{@github_api}/repos/#{owner}/#{repo}/issues/#{number}"

        case http_get(url, config) do
          {:ok, issue} -> {:cont, {:ok, [WorkItemMapper.from_github_issue(owner, repo, issue) | acc]}}
          {:error, _} = err -> {:halt, err}
        end
      end)

    case results do
      {:ok, items} -> {:ok, Enum.reverse(items)}
      {:error, _} = err -> err
    end
  end

  @impl true
  def fetch_issue_states_by_ids(_workspace_id, issue_ids), do: fetch_issue_states_by_ids(issue_ids)

  def create_comment(issue_id, body) do
    config = tracker_config()
    {owner, repo} = parse_repository(config.repository)
    number = extract_issue_number(issue_id)

    url = "#{@github_api}/repos/#{owner}/#{repo}/issues/#{number}/comments"
    payload = %{"body" => body}

    case http_post(url, payload, config) do
      {:ok, _} -> :ok
      {:error, _} = err -> err
    end
  end

  @impl true
  def create_comment(_workspace_id, issue_id, body), do: create_comment(issue_id, body)

  def update_issue_state(%WorkItem{id: id}, state_name), do: update_issue_state(id, state_name)

  def update_issue_state(issue_id, state_name) do
    config = tracker_config()
    {owner, repo} = parse_repository(config.repository)
    number = extract_issue_number(issue_id)

    url = "#{@github_api}/repos/#{owner}/#{repo}/issues/#{number}"
    gh_state = to_github_state(state_name)
    payload = %{"state" => gh_state}

    case http_patch(url, payload, config) do
      {:ok, _} -> :ok
      {:error, _} = err -> err
    end
  end

  @impl true
  def update_issue_state(_workspace_id, issue_or_id, state_name), do: update_issue_state(issue_or_id, state_name)

  defp fetch_all_pages(owner, repo, state, config, page \\ 1, acc \\ []) do
    url = "#{@github_api}/repos/#{owner}/#{repo}/issues?state=#{state}&per_page=100&page=#{page}"

    case http_get(url, config) do
      {:ok, []} ->
        {:ok, acc}

      {:ok, issues} when is_list(issues) ->
        if length(issues) < 100 do
          {:ok, acc ++ issues}
        else
          fetch_all_pages(owner, repo, state, config, page + 1, acc ++ issues)
        end

      {:error, _} = err ->
        err
    end
  end

  # GitHub's /issues endpoint returns PRs too — filter them out
  defp reject_pull_requests(issues) do
    Enum.reject(issues, fn issue -> issue["pull_request"] != nil end)
  end

  defp filter_by_active_states(work_items, active_states) do
    normalized = MapSet.new(active_states, &String.downcase/1)

    Enum.filter(work_items, fn item ->
      MapSet.member?(normalized, String.downcase(item.state || ""))
    end)
  end

  defp filter_by_label_states(work_items, state_names) do
    normalized = MapSet.new(state_names, &String.downcase/1)

    Enum.filter(work_items, fn item ->
      MapSet.member?(normalized, String.downcase(item.state || ""))
    end)
  end

  defp parse_repository(repo) when is_binary(repo) do
    case String.split(repo, "/") do
      [owner, name] -> {owner, name}
      _ -> raise ArgumentError, "Invalid repository format: #{repo}. Expected owner/repo"
    end
  end

  defp extract_issue_number(issue_id) when is_binary(issue_id) do
    case Integer.parse(issue_id) do
      {n, _} -> n
      :error -> raise ArgumentError, "Invalid GitHub issue ID: #{issue_id}"
    end
  end

  defp to_github_state(state) when is_binary(state) do
    case String.downcase(state) do
      s when s in ["open", "closed"] -> s
      _ -> "open"
    end
  end

  defp tracker_config do
    Config.settings!().tracker
  end

  defp auth_headers(config) do
    [
      {"authorization", "Bearer #{config.api_key}"},
      {"accept", "application/vnd.github+json"},
      {"x-github-api-version", "2022-11-28"}
    ]
  end

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :github_tracker_req_options, [])

  defp base_req(config) do
    [headers: auth_headers(config)]
    |> Keyword.merge(req_options())
    |> Req.new()
  end

  defp http_get(url, config) do
    case Req.get(base_req(config), url: url) do
      {:ok, %Req.Response{status: status, body: body}} when status in 200..299 ->
        {:ok, body}

      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, {:http_error, status, body}}

      {:error, reason} ->
        {:error, {:request_failed, reason}}
    end
  end

  defp http_post(url, payload, config) do
    case Req.post(base_req(config), url: url, json: payload) do
      {:ok, %Req.Response{status: status}} when status in 200..299 ->
        {:ok, :created}

      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, {:http_error, status, body}}

      {:error, reason} ->
        {:error, {:request_failed, reason}}
    end
  end

  defp http_patch(url, payload, config) do
    case Req.patch(base_req(config), url: url, json: payload) do
      {:ok, %Req.Response{status: status}} when status in 200..299 ->
        {:ok, :updated}

      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, {:http_error, status, body}}

      {:error, reason} ->
        {:error, {:request_failed, reason}}
    end
  end
end
