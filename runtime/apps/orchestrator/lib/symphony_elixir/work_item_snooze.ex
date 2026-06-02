defmodule SymphonyElixir.WorkItemSnooze do
  @moduledoc """
  Shared work-item snooze implementation for agent-callable tools.
  """

  alias SymphonyElixir.PostgRESTClient

  @work_items_table "work_items"
  @event_log_table "event_log"
  @min_snooze_seconds 10
  @max_snooze_seconds 86_400

  @type context :: map() | keyword()

  @spec tool_spec() :: map()
  def tool_spec do
    %{
      "name" => "snooze_work_item",
      "description" => "Delay manager polling for a work item until an absolute ISO-8601 timestamp or for a bounded number of seconds.",
      "inputSchema" => %{
        "type" => "object",
        "additionalProperties" => false,
        "required" => ["work_item_id"],
        "properties" => %{
          "work_item_id" => string_schema("Work item database UUID."),
          "until" => date_time_schema("Absolute ISO-8601 timestamp to snooze until."),
          "seconds" =>
            integer_schema(
              "Number of seconds to wait before polling again.",
              @min_snooze_seconds,
              @max_snooze_seconds
            ),
          "reason" => %{
            "type" => ["string", "null"],
            "description" => "Optional short reason for the audit log.",
            "maxLength" => 500
          }
        }
      }
    }
  end

  @spec manager_alias_spec() :: map()
  def manager_alias_spec do
    tool_spec()
    |> put_in(["name"], "snooze")
    |> put_in(["description"], "Delay the next manager poll for a work item.")
  end

  @spec snooze(map(), context()) :: {:ok, map()} | {:error, term()}
  def snooze(arguments, context \\ %{})

  def snooze(arguments, context) when is_map(arguments) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, work_item_id} <- required_string(args, "work_item_id"),
         {:ok, next_poll_at} <- resolve_next_poll_at(args),
         {:ok, actor} <- actor(context),
         {:ok, caller_workspace_id} <- caller_workspace_id(context),
         {:ok, client} <- client(context),
         {:ok, work_item} <- read_work_item(client, work_item_id, caller_workspace_id),
         {:ok, workspace_id} <- workspace_id(work_item),
         :ok <- assert_workspace_match(workspace_id, caller_workspace_id),
         {:ok, rows} <-
           patch_next_poll_at(client, work_item_id, workspace_id, next_poll_at),
         {:ok, _event} <-
           insert_snooze_event(client, workspace_id, work_item_id, next_poll_at, actor, args) do
      {:ok,
       %{
         "work_item_id" => work_item_id,
         "workspace_id" => workspace_id,
         "next_poll_at" => next_poll_at,
         "row" => row_result(rows)
       }}
    end
  end

  def snooze(_arguments, _context), do: {:error, :invalid_arguments}

  defp resolve_next_poll_at(args) do
    case {Map.get(args, "seconds"), Map.get(args, "until")} do
      {nil, nil} ->
        {:error, {:missing_argument, "seconds_or_until"}}

      {nil, until} ->
        resolve_until(until)

      {seconds, nil} ->
        with {:ok, seconds} <- integer_value(seconds, "seconds"),
             :ok <- validate_snooze_seconds(seconds) do
          {:ok, DateTime.utc_now() |> DateTime.add(seconds, :second) |> DateTime.to_iso8601()}
        end

      {_seconds, _until} ->
        {:error, {:invalid_argument, "seconds_or_until", "provide exactly one of seconds or until"}}
    end
  end

  defp resolve_until(until) when is_binary(until) do
    with {:ok, datetime, _offset} <- parse_until(until),
         :ok <- validate_future(datetime) do
      {:ok, DateTime.to_iso8601(datetime)}
    end
  end

  defp resolve_until(_until), do: {:error, {:invalid_argument, "until", "must be ISO-8601"}}

  defp parse_until(until) do
    case DateTime.from_iso8601(until) do
      {:ok, datetime, offset} -> {:ok, datetime, offset}
      {:error, _reason} -> {:error, {:invalid_argument, "until", "must be ISO-8601"}}
    end
  end

  defp validate_future(datetime) do
    if DateTime.compare(datetime, DateTime.utc_now()) == :gt do
      :ok
    else
      {:error, {:invalid_argument, "until", "must be in the future"}}
    end
  end

  defp validate_snooze_seconds(seconds) when seconds < @min_snooze_seconds,
    do: {:error, {:invalid_argument, "seconds", "must be at least #{@min_snooze_seconds}"}}

  defp validate_snooze_seconds(seconds) when seconds > @max_snooze_seconds,
    do: {:error, {:invalid_argument, "seconds", "must be at most #{@max_snooze_seconds}"}}

  defp validate_snooze_seconds(_seconds), do: :ok

  defp read_work_item(client, work_item_id, caller_workspace_id) do
    query =
      %{
        "select" => "id,workspace_id",
        "id" => "eq.#{work_item_id}",
        "limit" => "1"
      }
      |> maybe_put_workspace_filter(caller_workspace_id)

    case PostgRESTClient.get(client, @work_items_table, query) do
      {:ok, [row | _]} when is_map(row) -> {:ok, row}
      {:ok, []} -> {:error, :work_item_not_found}
      {:ok, row} when is_map(row) -> {:ok, row}
      {:ok, _body} -> {:error, :invalid_work_item_response}
      {:error, reason} -> {:error, {:supabase_error, reason}}
    end
  end

  defp patch_next_poll_at(client, work_item_id, workspace_id, next_poll_at) do
    case PostgRESTClient.patch(
           client,
           @work_items_table,
           %{"id" => "eq.#{work_item_id}", "workspace_id" => "eq.#{workspace_id}"},
           %{"next_poll_at" => next_poll_at},
           prefer: "return=representation"
         ) do
      {:ok, rows} -> {:ok, rows}
      {:error, reason} -> {:error, {:supabase_error, reason}}
    end
  end

  defp insert_snooze_event(client, workspace_id, work_item_id, next_poll_at, actor, args) do
    payload =
      %{
        "actor" => actor,
        "next_poll_at" => next_poll_at
      }
      |> maybe_put("reason", optional_string(args, "reason"))

    case PostgRESTClient.post(
           client,
           @event_log_table,
           %{
             "workspace_id" => workspace_id,
             "work_item_id" => work_item_id,
             "kind" => "work_item.snoozed",
             "source" => "agent_tool",
             "payload" => payload
           },
           prefer: "return=representation",
           query: %{"select" => "id,kind,payload"}
         ) do
      {:ok, response} -> {:ok, response}
      {:error, reason} -> {:error, {:supabase_error, reason}}
    end
  end

  defp maybe_put_workspace_filter(query, workspace_id)
       when is_binary(workspace_id) and workspace_id != "",
       do: Map.put(query, "workspace_id", "eq.#{workspace_id}")

  defp maybe_put_workspace_filter(query, _workspace_id), do: query

  defp caller_workspace_id(context) do
    case map_value(context, :workspace_id) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :missing_caller_workspace_id}
    end
  end

  defp assert_workspace_match(row_workspace_id, caller_workspace_id)
       when row_workspace_id == caller_workspace_id,
       do: :ok

  defp assert_workspace_match(_row_workspace_id, _caller_workspace_id),
    do: {:error, :workspace_mismatch}

  defp actor(context) do
    case map_value(context, :actor) do
      %{"kind" => "agent", "agent_id" => agent_id} when is_binary(agent_id) and agent_id != "" ->
        {:ok, %{"kind" => "agent", "agent_id" => agent_id}}

      %{kind: "agent", agent_id: agent_id} when is_binary(agent_id) and agent_id != "" ->
        {:ok, %{"kind" => "agent", "agent_id" => agent_id}}

      _ ->
        case map_value(context, :agent_id) do
          agent_id when is_binary(agent_id) and agent_id != "" ->
            {:ok, %{"kind" => "agent", "agent_id" => agent_id}}

          _ ->
            {:error, :unauthorized_agent_caller}
        end
    end
  end

  defp client(context) do
    config =
      Application.get_env(:symphony_elixir, :work_item_snooze, [])
      |> normalize_config()
      |> Map.merge(normalize_config(Application.get_env(:symphony_elixir, :manager_tools, [])))
      |> Map.merge(normalize_config(map_value(context, :config) || []))

    req_options = map_value(context, :req_options) || req_options()

    {:ok, PostgRESTClient.new(config, req_options)}
  rescue
    error in ArgumentError -> {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp req_options do
    Application.get_env(:symphony_elixir, :work_item_snooze_req_options) ||
      Application.get_env(:symphony_elixir, :manager_tools_req_options, [])
  end

  defp workspace_id(%{"workspace_id" => workspace_id}) when is_binary(workspace_id) and workspace_id != "",
    do: {:ok, workspace_id}

  defp workspace_id(_row), do: {:error, :missing_workspace_id}

  defp row_result([row | _]) when is_map(row), do: row
  defp row_result(row) when is_map(row), do: row
  defp row_result(_rows), do: nil

  defp normalize_arguments(arguments) when is_map(arguments) do
    {:ok, Map.new(arguments, fn {key, value} -> {to_string(key), value} end)}
  end

  defp normalize_arguments(_arguments), do: {:error, :invalid_arguments}

  defp required_string(args, key) do
    case Map.get(args, key) do
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> {:error, {:missing_argument, key}}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, {:missing_argument, key}}
    end
  end

  defp integer_value(value, _key) when is_integer(value), do: {:ok, value}
  defp integer_value(value, key) when is_binary(value), do: parse_integer(value, key)
  defp integer_value(_value, key), do: {:error, {:missing_argument, key}}

  defp parse_integer(value, key) do
    case Integer.parse(value) do
      {integer, ""} -> {:ok, integer}
      _ -> {:error, {:invalid_argument, key, "must be an integer"}}
    end
  end

  defp optional_string(args, key) do
    case Map.get(args, key) do
      value when is_binary(value) ->
        value = String.trim(value)
        if value == "", do: nil, else: String.slice(value, 0, 500)

      _ ->
        nil
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp map_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))
  defp map_value(list, key) when is_list(list), do: Keyword.get(list, key)
  defp map_value(_value, _key), do: nil

  defp normalize_config(nil), do: %{}
  defp normalize_config(config) when is_list(config), do: Map.new(config)
  defp normalize_config(config) when is_map(config), do: config

  defp string_schema(description), do: %{"type" => "string", "description" => description}

  defp date_time_schema(description),
    do: %{"type" => "string", "format" => "date-time", "description" => description}

  defp integer_schema(description, minimum, maximum) do
    %{
      "type" => "integer",
      "description" => description,
      "minimum" => minimum,
      "maximum" => maximum
    }
  end
end
