defmodule SymphonyElixir.WorkItem.Mapper do
  @moduledoc """
  Source-specific mappers into the canonical `SymphonyElixir.WorkItem` struct.

  Keep these functions explicit. They are the adapter boundary where source
  schemas become the orchestrator's stable work item contract.
  """

  alias SymphonyElixir.Time, as: Timestamp
  alias SymphonyElixir.WorkItem

  @spec from_database_row(map(), keyword()) :: WorkItem.t()
  def from_database_row(row, opts \\ []) when is_map(row) do
    metadata =
      row
      |> Map.get("metadata")
      |> metadata()
      |> maybe_put_blocked_by(Map.get(row, "depends_on"))
      |> maybe_put_new("workspace_id", Map.get(row, "workspace_id"))

    runner_type =
      Keyword.get(opts, :runner_type) ||
        row["runner_kind"] ||
        row["runner_type"] ||
        Map.get(metadata, "runner_kind") ||
        Map.get(metadata, "runner_type")

    %WorkItem{
      id: Map.get(row, "id"),
      identifier: Map.get(row, "identifier"),
      title: Map.get(row, "title"),
      description: Map.get(row, "description"),
      priority: Map.get(row, "priority"),
      state: Map.get(row, "state"),
      url: Map.get(row, "url") || metadata_url(metadata),
      source: source(row, opts),
      runner_type: runner_type,
      repository_id: repository_id(row, metadata),
      repository: repository(row, metadata),
      plan_id: Map.get(row, "plan_id"),
      task_id: Map.get(row, "task_id"),
      labels: normalize_labels(Map.get(row, "labels")),
      metadata: metadata,
      created_at: Timestamp.parse_iso8601(Map.get(row, "created_at")),
      updated_at: Timestamp.parse_iso8601(Map.get(row, "updated_at"))
    }
  end

  @spec from_github_issue(String.t(), String.t(), map()) :: WorkItem.t()
  def from_github_issue(owner, repo, issue) when is_binary(owner) and is_binary(repo) and is_map(issue) do
    number = issue["number"]
    labels = normalize_labels(issue["labels"])
    status_label = Enum.find(labels, &String.starts_with?(&1, "status:"))

    state =
      if status_label do
        String.replace_prefix(status_label, "status:", "")
      else
        issue["state"]
      end

    %WorkItem{
      id: to_string(number),
      identifier: "GH-#{number}",
      title: issue["title"],
      description: issue["body"],
      priority: nil,
      state: state,
      url: issue["html_url"],
      source: "github",
      labels: labels,
      metadata: %{
        assignee: get_in(issue, ["assignee", "login"]),
        milestone: get_in(issue, ["milestone", "title"]),
        pull_request: issue["pull_request"] != nil,
        repository: "#{owner}/#{repo}"
      },
      created_at: Timestamp.parse_iso8601(issue["created_at"]),
      updated_at: Timestamp.parse_iso8601(issue["updated_at"])
    }
  end

  @spec from_api_payload(map(), DateTime.t()) :: WorkItem.t()
  def from_api_payload(payload, now \\ DateTime.utc_now()) when is_map(payload) do
    id = payload["id"] || generate_id()

    %WorkItem{
      id: id,
      identifier: payload["identifier"] || "API-#{String.slice(id, 0..7)}",
      title: payload["title"],
      description: payload["description"],
      priority: payload["priority"],
      state: payload["state"] || "Todo",
      url: payload["url"] || metadata_url(payload["metadata"]),
      source: "api",
      runner_type: payload["runner_type"],
      labels: normalize_labels(payload["labels"]),
      metadata: metadata(payload["metadata"]),
      created_at: now,
      updated_at: now
    }
  end

  @spec normalize_labels(term()) :: [String.t()]
  def normalize_labels(nil), do: []

  def normalize_labels(labels) when is_list(labels) do
    labels
    |> Enum.map(&label_name/1)
    |> Enum.reject(&blank?/1)
  end

  def normalize_labels(_), do: []

  @spec metadata_url(term()) :: String.t() | nil
  def metadata_url(metadata) when is_map(metadata), do: Map.get(metadata, "url") || Map.get(metadata, :url)
  def metadata_url(_), do: nil

  defp metadata(value) when is_map(value), do: value
  defp metadata(_), do: %{}

  defp repository_id(row, metadata) do
    string_value(Map.get(row, "repository_id")) ||
      string_value(Map.get(metadata, "repository_id")) ||
      string_value(Map.get(metadata, :repository_id)) ||
      string_value(Map.get(metadata, "repo_id")) ||
      string_value(Map.get(metadata, :repo_id))
  end

  defp repository(row, metadata) do
    string_value(Map.get(row, "repository")) ||
      string_value(Map.get(metadata, "repository")) ||
      string_value(Map.get(metadata, :repository))
  end

  defp maybe_put_new(map, _key, nil), do: map
  defp maybe_put_new(map, key, value), do: Map.put_new(map, key, value)

  defp maybe_put_blocked_by(metadata, depends_on) when is_map(metadata) and is_list(depends_on) and depends_on != [] do
    if Map.has_key?(metadata, :blocked_by) or Map.has_key?(metadata, "blocked_by") do
      metadata
    else
      Map.put(metadata, :blocked_by, depends_on)
    end
  end

  defp maybe_put_blocked_by(metadata, _depends_on), do: metadata

  defp string_value(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp string_value(_value), do: nil

  defp source(row, opts) do
    case Keyword.get(opts, :source, :database) do
      :row -> Map.get(row, "source") || "database"
      :database -> "database"
    end
  end

  defp label_name(value) when is_binary(value), do: value
  defp label_name(%{"name" => name}) when is_binary(name), do: name
  defp label_name(%{name: name}) when is_binary(name), do: name
  defp label_name(_), do: nil

  defp blank?(value) when value in [nil, ""], do: true
  defp blank?(_), do: false

  defp generate_id do
    :crypto.strong_rand_bytes(16) |> Base.hex_encode32(case: :lower, padding: false) |> String.slice(0..25)
  end
end
