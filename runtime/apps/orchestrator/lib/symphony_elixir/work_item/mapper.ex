defmodule SymphonyElixir.WorkItem.Mapper do
  @moduledoc """
  Source-specific mappers into the canonical `SymphonyElixir.WorkItem` struct.

  Keep these functions explicit. They are the adapter boundary where source
  schemas become the orchestrator's stable work item contract.
  """

  alias SymphonyElixir.Time, as: Timestamp
  alias SymphonyElixir.WorkItem
  alias SymphonyElixir.Schema.ExecutionProfile

  @list_fields ~w(depends_on depends_on_author_ids completion_gates)

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
      description: Map.get(row, "description") || Map.get(row, "instructions"),
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

  @spec normalize_intake_payload(map()) :: {:ok, map(), [map()]} | {:error, tuple()}
  def normalize_intake_payload(payload) when is_map(payload) do
    payload
    |> stringify_keys()
    |> normalize_scalar_string("runner_kind", &normalize_runner_kind/1)
    |> normalize_scalar_string("state", &normalize_work_item_state/1)
    |> normalize_scalar_string("status", &normalize_work_item_state/1)
    |> normalize_scalar_string("intent", &normalize_intent/1)
    |> normalize_list_fields()
    |> normalize_labels_field()
    |> normalize_routing_field()
    |> normalize_metadata_routing_field()
    |> materialize_top_level_intent()
    |> case do
      {:ok, normalized, feedback} -> {:ok, normalized, Enum.reverse(feedback)}
      {:error, _reason} = error -> error
    end
  end

  def normalize_intake_payload(_payload), do: {:error, :invalid_payload}

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

  defp stringify_keys(map), do: {:ok, Map.new(map, fn {key, value} -> {to_string(key), value} end), []}

  defp normalize_scalar_string({:ok, map, feedback}, key, normalizer) do
    case Map.get(map, key) do
      value when value in [nil, ""] ->
        {:ok, map, feedback}

      value when is_binary(value) or is_atom(value) ->
        original = to_string(value)

        case normalizer.(original) do
          {:ok, normalized} ->
            {:ok, Map.put(map, key, normalized), maybe_feedback(feedback, key, original, normalized)}

          {:error, message} ->
            {:error, {:invalid_argument, key, message}}
        end

      _ ->
        {:error, {:invalid_argument, key, "must be a string"}}
    end
  end

  defp normalize_scalar_string({:error, _reason} = error, _key, _normalizer), do: error

  defp normalize_list_fields({:ok, map, feedback}) do
    Enum.reduce_while(@list_fields, {:ok, map, feedback}, fn key, {:ok, acc, acc_feedback} ->
      case normalize_string_list(Map.get(acc, key)) do
        {:ok, value, nil} ->
          {:cont, {:ok, maybe_put_value(acc, key, value), acc_feedback}}

        {:ok, value, message} ->
          {:cont, {:ok, maybe_put_value(acc, key, value), prepend_feedback(acc_feedback, key, message, value)}}

        {:error, message} ->
          {:halt, {:error, {:invalid_argument, key, message}}}
      end
    end)
  end

  defp normalize_list_fields({:error, _reason} = error), do: error

  defp normalize_labels_field({:ok, map, feedback}) do
    case Map.get(map, "labels") do
      nil ->
        {:ok, map, feedback}

      labels ->
        normalized = normalize_labels(List.wrap(labels))
        message = if is_list(labels), do: nil, else: "wrapped scalar in list"

        {:ok, Map.put(map, "labels", normalized), maybe_prepend_feedback(feedback, "labels", message, normalized)}
    end
  end

  defp normalize_labels_field({:error, _reason} = error), do: error

  defp normalize_routing_field({:ok, map, feedback}) do
    case normalize_routing(Map.get(map, "routing")) do
      {:ok, nil, routing_feedback} ->
        {:ok, map, routing_feedback ++ feedback}

      {:ok, routing, routing_feedback} ->
        {:ok, Map.put(map, "routing", routing), routing_feedback ++ feedback}

      {:error, _reason} = error ->
        error
    end
  end

  defp normalize_routing_field({:error, _reason} = error), do: error

  defp normalize_metadata_routing_field({:ok, %{"metadata" => metadata} = map, feedback}) when is_map(metadata) do
    metadata = stringify_metadata_keys(metadata)

    case normalize_routing(Map.get(metadata, "routing")) do
      {:ok, nil, routing_feedback} ->
        {:ok, Map.put(map, "metadata", metadata), routing_feedback ++ feedback}

      {:ok, routing, routing_feedback} ->
        {:ok, Map.put(map, "metadata", Map.put(metadata, "routing", routing)), routing_feedback ++ feedback}

      {:error, _reason} = error ->
        error
    end
  end

  defp normalize_metadata_routing_field({:ok, map, feedback}), do: {:ok, map, feedback}
  defp normalize_metadata_routing_field({:error, _reason} = error), do: error

  defp materialize_top_level_intent({:ok, %{"intent" => intent} = map, feedback}) when is_binary(intent) do
    routing =
      case Map.get(map, "routing") do
        routing when is_map(routing) -> Map.put_new(routing, "intent", intent)
        _ -> %{"intent" => intent}
      end

    {:ok, Map.put(map, "routing", routing), feedback}
  end

  defp materialize_top_level_intent(result), do: result

  defp normalize_routing(nil), do: {:ok, nil, []}

  defp normalize_routing(routing) when is_map(routing) do
    {:ok, stringify_metadata_keys(routing), []}
    |> normalize_scalar_string("runner_kind", &normalize_runner_kind/1)
    |> normalize_scalar_string("intent", &normalize_intent/1)
    |> normalize_scalar_string("execution_location", &normalize_intent/1)
  end

  defp normalize_routing(_routing), do: {:error, {:invalid_argument, "routing", "must be an object"}}

  defp normalize_string_list(nil), do: {:ok, nil, nil}

  defp normalize_string_list(values) when is_list(values) do
    if Enum.all?(values, &string_list_entry?/1) do
      values =
        values
        |> Enum.map(&string_value/1)
        |> Enum.reject(&is_nil/1)

      {:ok, values, nil}
    else
      {:error, "must be a string or list of strings"}
    end
  end

  defp normalize_string_list(value) when is_binary(value) or is_atom(value),
    do: {:ok, [to_string(value) |> String.trim()], "wrapped scalar in list"}

  defp normalize_string_list(_value), do: {:error, "must be a string or list of strings"}

  defp string_list_entry?(value) when is_binary(value) or is_atom(value), do: true
  defp string_list_entry?(_value), do: false

  defp normalize_runner_kind(value) do
    normalized = value |> normalize_intake_token()

    if normalized in ExecutionProfile.supported_runner_kinds() do
      {:ok, normalized}
    else
      {:error, "must be a supported runner kind"}
    end
  end

  defp normalize_work_item_state(value), do: {:ok, normalize_intake_token(value)}
  defp normalize_intent(value), do: {:ok, normalize_intake_token(value)}

  defp normalize_intake_token(value) do
    value
    |> to_string()
    |> String.trim()
    |> String.downcase()
    |> String.replace(~r/[\s-]+/, "_")
  end

  defp maybe_put_value(map, _key, nil), do: map
  defp maybe_put_value(map, key, value), do: Map.put(map, key, value)

  defp maybe_feedback(feedback, _key, value, value), do: feedback

  defp maybe_feedback(feedback, key, _original, normalized),
    do: prepend_feedback(feedback, key, "normalized value", normalized)

  defp maybe_prepend_feedback(feedback, _key, nil, _value), do: feedback
  defp maybe_prepend_feedback(feedback, key, message, value), do: prepend_feedback(feedback, key, message, value)

  defp prepend_feedback(feedback, field, message, suggested_default) do
    [
      %{
        "code" => "normalized_field",
        "field" => field,
        "message" => message,
        "recoverable" => true,
        "suggested_default" => suggested_default,
        "ask_user" => false
      }
      | feedback
    ]
  end

  defp stringify_metadata_keys(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), value}
      {key, value} -> {key, value}
    end)
  end

  defp blank?(value) when value in [nil, ""], do: true
  defp blank?(_), do: false

  defp generate_id do
    :crypto.strong_rand_bytes(16) |> Base.hex_encode32(case: :lower, padding: false) |> String.slice(0..25)
  end
end
