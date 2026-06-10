defmodule SymphonyElixir.Manager.ToolSupport do
  @moduledoc """
  Shared execution support for manager-agent tools.
  """

  require Logger

  alias SymphonyElixir.{AgentRunner, PostgRESTClient, WorkItem, WorkItemSnooze}
  alias SymphonyElixir.WorkItem.Mapper, as: WorkItemMapper
  alias SymphonyElixir.Launcher.GatewayConfig.Database, as: GatewayConfigDatabase
  alias SymphonyElixir.Routing.IntentVocabulary

  @plan_table "plan"
  @work_items_table "work_items"
  @escalation_table "escalation"

  def list_plans(arguments, context) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, session_workspace_id} <- session_workspace_id(context),
         :ok <- reject_workspace_override(args, session_workspace_id),
         {:ok, limit} <- optional_limit(args),
         {:ok, client} <- client(context) do
      query =
        %{
          "select" => "id,workspace_id,name,description,type,status,is_ongoing,created_at,updated_at",
          "order" => "updated_at.desc.nullslast",
          "limit" => Integer.to_string(limit),
          "workspace_id" => "eq.#{session_workspace_id}"
        }
        |> maybe_filter("status", optional_string(args, "status"))

      case PostgRESTClient.get(client, @plan_table, query) do
        {:ok, rows} when is_list(rows) -> success(rows)
        {:ok, row} when is_map(row) -> success([row])
        {:error, reason} -> failure("supabase_error", reason)
      end
    else
      {:error, reason} -> failure("invalid_arguments", reason)
    end
  end

  def list_work_items(arguments, context) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, session_workspace_id} <- session_workspace_id(context),
         :ok <- reject_workspace_override(args, session_workspace_id),
         {:ok, limit} <- optional_limit(args),
         {:ok, client} <- client(context) do
      query =
        %{
          "select" => "id,workspace_id,identifier,title,state,source,url,labels,metadata,next_poll_at,last_polled_at,poll_cadence_seconds,created_at,updated_at",
          "order" => "updated_at.desc.nullslast",
          "limit" => Integer.to_string(limit),
          "workspace_id" => "eq.#{session_workspace_id}"
        }
        |> maybe_filter("state", optional_string(args, "state"))
        |> maybe_due_filter(Map.get(args, "due_only"))

      case PostgRESTClient.get(client, @work_items_table, query) do
        {:ok, rows} when is_list(rows) -> success(rows)
        {:ok, row} when is_map(row) -> success([row])
        {:error, reason} -> failure("supabase_error", reason)
      end
    else
      {:error, reason} -> failure("invalid_arguments", reason)
    end
  end

  def dispatch_runner(arguments, context) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, work_item_id} <- required_string(args, "work_item_id"),
         {:ok, intent} <- required_string(args, "intent"),
         {:ok, runner_kind} <- dispatch_runner_kind(args, intent),
         {:ok, dispatch_context} <- optional_map(args, "context"),
         {:ok, client} <- client(context),
         {:ok, row} <- read_work_item(client, work_item_id),
         {:ok, workspace_id} <- workspace_id(row),
         {:ok, route} <- fetch_runner_route(workspace_id, runner_kind) do
      row_metadata = metadata(row)

      case find_in_flight_dispatch(row_metadata, runner_kind, intent) do
        %{"runner_session_id" => runner_session_id} = dispatch ->
          success(%{
            "runner_session_id" => runner_session_id,
            "idempotent" => true,
            "dispatch" => dispatch
          })

        nil ->
          dispatch = new_dispatch(runner_kind, intent, dispatch_context)

          with :ok <-
                 normalize_dispatch_result(
                   dispatcher(context).(
                     WorkItemMapper.from_database_row(row,
                       runner_type: runner_kind,
                       source: :row
                     ),
                     route,
                     dispatch
                   )
                 ),
               :ok <-
                 update_work_item_metadata(
                   client,
                   work_item_id,
                   put_in_flight_dispatch(row_metadata, dispatch)
                 ) do
            success(%{
              "runner_session_id" => dispatch["runner_session_id"],
              "idempotent" => false,
              "route" => route
            })
          else
            {:error, reason} -> failure("dispatch_error", reason)
          end
      end
    else
      {:error, reason} -> failure("invalid_arguments", reason)
    end
  end

  def escalate_to_human(arguments, context) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, work_item_id} <- required_string(args, "work_item_id"),
         {:ok, trigger_kind} <- required_string(args, "trigger_kind"),
         {:ok, question} <- required_string(args, "question"),
         {:ok, context_summary} <- required_string(args, "context_summary"),
         {:ok, client} <- client(context),
         {:ok, row} <- read_work_item(client, work_item_id),
         {:ok, workspace_id} <- workspace_id(row),
         payload = build_escalation_payload(args, question, context_summary),
         escalation =
           build_escalation_row(work_item_id, workspace_id, trigger_kind, args, payload),
         {:ok, inserted} <- insert_escalation(client, escalation),
         :ok <- update_work_item_state(client, work_item_id, "escalated") do
      success(%{
        "work_item_id" => work_item_id,
        "state" => "escalated",
        "escalation" => inserted
      })
    else
      {:error, reason} -> failure("invalid_arguments", reason)
    end
  end

  def snooze(arguments, context) do
    snooze_context =
      context
      |> Map.put_new(:actor, %{"kind" => "agent", "agent_id" => manager_agent_id(context)})
      |> maybe_put_caller_workspace_id(context)

    case WorkItemSnooze.snooze(arguments, snooze_context) do
      {:ok, payload} -> success(payload)
      {:error, {:supabase_error, reason}} -> failure("supabase_error", reason)
      {:error, reason} -> failure("invalid_arguments", reason)
    end
  end

  def mark_done(arguments, context) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, work_item_id} <- required_string(args, "work_item_id"),
         {:ok, client} <- client(context) do
      case PostgRESTClient.patch(
             client,
             @work_items_table,
             id_query(work_item_id),
             %{"state" => "done", "next_poll_at" => nil},
             prefer: "return=representation"
           ) do
        {:ok, rows} ->
          success(%{
            "work_item_id" => work_item_id,
            "state" => row_state(rows) || "done",
            "row" => row_result(rows)
          })

        {:error, reason} ->
          failure("supabase_error", reason)
      end
    else
      {:error, reason} -> failure("invalid_arguments", reason)
    end
  end

  def string_schema(description), do: %{"type" => "string", "description" => description}

  def nullable_string_schema(description),
    do: %{"type" => ["string", "null"], "description" => description}

  def date_time_schema(description),
    do: %{"type" => "string", "format" => "date-time", "description" => description}

  def enum_schema(values, description),
    do: %{"type" => "string", "enum" => values, "description" => description}

  def nullable_enum_schema(values, description),
    do: %{"type" => ["string", "null"], "enum" => values ++ [nil], "description" => description}

  def integer_schema(description, minimum, maximum) do
    %{
      "type" => "integer",
      "description" => description,
      "minimum" => minimum,
      "maximum" => maximum
    }
  end

  defp read_work_item(client, work_item_id) do
    case PostgRESTClient.get(
           client,
           @work_items_table,
           Map.put(id_query(work_item_id), "limit", "1")
         ) do
      {:ok, [row | _]} when is_map(row) -> {:ok, row}
      {:ok, []} -> {:error, {:work_item_not_found, work_item_id}}
      {:ok, row} when is_map(row) -> {:ok, row}
      {:error, reason} -> {:error, reason}
    end
  end

  defp update_work_item_metadata(client, work_item_id, metadata) when is_map(metadata) do
    case PostgRESTClient.patch(
           client,
           @work_items_table,
           id_query(work_item_id),
           %{"metadata" => metadata},
           prefer: "return=representation"
         ) do
      {:ok, _rows} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp update_work_item_state(client, work_item_id, state) do
    case PostgRESTClient.patch(
           client,
           @work_items_table,
           id_query(work_item_id),
           %{"state" => state},
           prefer: "return=representation"
         ) do
      {:ok, _rows} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp insert_escalation(client, payload) when is_map(payload) do
    case PostgRESTClient.post(client, @escalation_table, payload,
           prefer: "return=representation",
           query: %{"select" => "*"}
         ) do
      {:ok, [row | _]} when is_map(row) -> {:ok, row}
      {:ok, row} when is_map(row) -> {:ok, row}
      {:ok, _body} -> {:ok, payload}
      {:error, reason} -> {:error, reason}
    end
  end

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

  defp optional_map(args, key) do
    case Map.get(args, key) do
      nil -> {:ok, %{}}
      value when is_map(value) -> {:ok, value}
      _ -> {:error, {:invalid_argument, key, "must be an object"}}
    end
  end

  defp optional_string(args, key) do
    case Map.get(args, key) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp dispatch_runner_kind(args, intent) do
    case optional_string(args, "runner_kind") || IntentVocabulary.manager_dispatch_runner_kind(intent) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:unsupported_dispatch_intent, intent}}
    end
  end

  defp optional_limit(args) do
    case Map.get(args, "limit") do
      nil -> {:ok, 25}
      value when is_integer(value) and value >= 1 and value <= 100 -> {:ok, value}
      value when is_binary(value) -> parse_limited_integer(value, "limit", 1, 100)
      _ -> {:error, {:invalid_argument, "limit", "must be an integer from 1 to 100"}}
    end
  end

  defp maybe_filter(query, _field, nil), do: query
  defp maybe_filter(query, field, value), do: Map.put(query, field, "eq.#{value}")

  defp maybe_due_filter(query, true) do
    Map.put(query, "next_poll_at", "lte.#{DateTime.utc_now() |> DateTime.to_iso8601()}")
  end

  defp maybe_due_filter(query, _value), do: query

  defp metadata(%{"metadata" => metadata}) when is_map(metadata), do: metadata
  defp metadata(_row), do: %{}

  defp workspace_id(row) do
    case Map.get(row, "workspace_id") || get_in(metadata(row), ["workspace_id"]) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :missing_workspace_id}
    end
  end

  defp session_workspace_id(context) do
    session = Map.get(context, :session) || Map.get(context, "session") || %{}

    value =
      Map.get(session, :workspace_id) || Map.get(session, "workspace_id") ||
        Map.get(context, :workspace_id) || Map.get(context, "workspace_id")

    case value do
      v when is_binary(v) and v != "" -> {:ok, v}
      _ -> {:error, :missing_session_workspace_id}
    end
  end

  defp manager_agent_id(context) do
    session = Map.get(context, :session) || Map.get(context, "session") || %{}

    Map.get(session, :agent_id) || Map.get(session, "agent_id") ||
      Map.get(context, :agent_id) || Map.get(context, "agent_id") || "manager"
  end

  defp maybe_put_caller_workspace_id(snooze_context, context) do
    case session_workspace_id(context) do
      {:ok, workspace_id} -> Map.put(snooze_context, :workspace_id, workspace_id)
      {:error, _reason} -> snooze_context
    end
  end

  defp reject_workspace_override(args, session_workspace_id) do
    case Map.get(args, "workspace_id") do
      nil ->
        :ok

      "" ->
        :ok

      value when is_binary(value) and value == session_workspace_id ->
        :ok

      _other ->
        {:error, {:invalid_argument, "workspace_id", "must match the session workspace"}}
    end
  end

  defp fetch_runner_route(workspace_id, runner_kind) do
    with {:ok, resolved} <- GatewayConfigDatabase.fetch("workspace", workspace_id),
         {:ok, route} <- find_runner_route(resolved.config_json, runner_kind) do
      {:ok, route}
    end
  end

  defp find_runner_route(config_json, runner_kind) when is_map(config_json) do
    routing = Map.get(config_json, "routing") || %{}
    runners = Map.get(config_json, "runners") || %{}

    route =
      find_route_in_routing(routing, runner_kind) ||
        Map.get(runners, runner_kind)

    case route do
      route when is_map(route) ->
        {:ok, route |> stringify_keys() |> Map.put_new("runner_kind", runner_kind)}

      _ ->
        {:error, {:route_not_found, runner_kind}}
    end
  end

  defp find_runner_route(_config_json, runner_kind), do: {:error, {:route_not_found, runner_kind}}

  defp find_route_in_routing(%{"rules" => rules}, runner_kind) when is_list(rules) do
    Enum.find(rules, fn rule ->
      (Map.get(rule, "runner_kind") || Map.get(rule, "runner")) == runner_kind
    end)
  end

  defp find_route_in_routing(routing, runner_kind) when is_map(routing),
    do: Map.get(routing, runner_kind)

  defp find_route_in_routing(_routing, _runner_kind), do: nil

  defp stringify_keys(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), value}
      {key, value} -> {key, value}
    end)
  end

  defp find_in_flight_dispatch(metadata, runner_kind, intent) do
    metadata
    |> Map.get("in_flight_dispatches", [])
    |> List.wrap()
    |> Enum.find(fn
      %{"runner_kind" => ^runner_kind, "intent" => ^intent, "status" => "in_flight"} -> true
      %{"runner_kind" => ^runner_kind, "intent" => ^intent} -> true
      _ -> false
    end)
  end

  defp put_in_flight_dispatch(metadata, dispatch) do
    dispatches =
      metadata
      |> Map.get("in_flight_dispatches", [])
      |> List.wrap()

    Map.put(metadata, "in_flight_dispatches", [dispatch | dispatches])
  end

  defp new_dispatch(runner_kind, intent, context) do
    %{
      "runner_kind" => runner_kind,
      "intent" => intent,
      "context" => context,
      "runner_session_id" => "mgr_" <> Ecto.UUID.generate(),
      "status" => "in_flight",
      "dispatched_at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }
  end

  defp build_escalation_payload(args, question, context_summary) do
    %{
      "question" => question,
      "context_summary" => context_summary
    }
    |> maybe_put("candidate_options", Map.get(args, "candidate_options"))
    |> maybe_put("preferred_option_id", optional_string(args, "preferred_option_id"))
    |> maybe_put("urgency", optional_string(args, "urgency"))
  end

  defp build_escalation_row(work_item_id, workspace_id, trigger_kind, args, payload) do
    %{
      "work_item_id" => work_item_id,
      "workspace_id" => workspace_id,
      "triggered_by" => "manager",
      "trigger_kind" => trigger_kind,
      "reason_kind" => optional_string(args, "reason_kind"),
      "payload" => payload
    }
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp dispatcher(context) do
    Map.get(context, :dispatcher) || Map.get(context, "dispatcher") || (&default_dispatch/3)
  end

  defp normalize_dispatch_result(:ok), do: :ok
  defp normalize_dispatch_result({:ok, _result}), do: :ok
  defp normalize_dispatch_result({:error, _reason} = error), do: error
  defp normalize_dispatch_result(other), do: {:error, {:invalid_dispatch_result, other}}

  defp default_dispatch(%WorkItem{} = work_item, route, dispatch) do
    case Task.start(fn ->
           AgentRunner.run(work_item, nil,
             manager_dispatch: dispatch,
             runner_config_override: route
           )
         end) do
      {:ok, _pid} ->
        :ok

      {:error, reason} ->
        Logger.warning("manager dispatch failed to start: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp parse_integer(value, key) do
    case Integer.parse(value) do
      {integer, ""} -> {:ok, integer}
      _ -> {:error, {:invalid_argument, key, "must be an integer"}}
    end
  end

  defp parse_limited_integer(value, key, minimum, maximum) do
    case parse_integer(value, key) do
      {:ok, integer} when integer >= minimum and integer <= maximum ->
        {:ok, integer}

      {:ok, _integer} ->
        {:error, {:invalid_argument, key, "must be from #{minimum} to #{maximum}"}}

      {:error, _reason} = error ->
        error
    end
  end

  defp id_query(work_item_id), do: %{"id" => "eq.#{work_item_id}"}

  defp row_result([row | _]) when is_map(row), do: row
  defp row_result([]), do: nil
  defp row_result(row) when is_map(row), do: row
  defp row_result(other), do: other

  defp row_state(rows) do
    case row_result(rows) do
      %{"state" => state} when is_binary(state) -> state
      _ -> nil
    end
  end

  defp success(value) do
    %{"success" => true, "output" => Jason.encode!(value)}
  end

  defp failure(error, reason) do
    %{
      "success" => false,
      "error" => error,
      "output" => Jason.encode!(%{"error" => error, "reason" => encode_reason(reason)})
    }
  end

  defp encode_reason(reason)
       when is_binary(reason) or is_number(reason) or is_boolean(reason) or is_nil(reason),
       do: reason

  defp encode_reason(reason) when is_map(reason) or is_list(reason), do: reason

  # Surface PostgREST HTTP errors as a structured object instead of an
  # Elixir-inspect'd string. The body carries the PostgreSQL error code
  # / message / hint (e.g. `"column work_items.url does not exist"`) and
  # is the only thing the model can use to self-correct on a retry. The
  # inspect form is valid JSON-as-a-string but the model has to parse
  # it back; a structured map is unambiguous.
  defp encode_reason({:http_error, status, body}) when is_integer(status) do
    %{"kind" => "http_error", "status" => status, "body" => encode_reason(body)}
  end

  defp encode_reason(reason), do: inspect(reason)

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :manager_tools_req_options, [])

  defp client(context) do
    config =
      Application.get_env(:symphony_elixir, :manager_tools, [])
      |> normalize_config()
      |> Map.merge(normalize_config(Map.get(context, :config) || Map.get(context, "config") || []))

    req_options =
      Map.get(context, :req_options) || Map.get(context, "req_options") || req_options()

    {:ok, PostgRESTClient.new(config, req_options)}
  rescue
    error in ArgumentError -> {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp normalize_config(nil), do: %{}
  defp normalize_config(config) when is_list(config), do: Map.new(config)
  defp normalize_config(config) when is_map(config), do: config
end
