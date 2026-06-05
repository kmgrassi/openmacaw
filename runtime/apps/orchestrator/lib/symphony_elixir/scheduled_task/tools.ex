defmodule SymphonyElixir.ScheduledTask.Tools do
  @moduledoc """
  Generic runtime tools for persisted scheduled tasks.
  """

  alias SymphonyElixir.ScheduledTask.{Delivery, NextRun, Repository}
  alias SymphonyElixir.Time

  @create_fields ~w(workspace_id agent_id source_work_item_id instructions enabled schedule timezone next_run_at delivery metadata)
  @update_fields ~w(agent_id source_work_item_id instructions enabled schedule timezone next_run_at delivery metadata)
  @nullable_update_fields ~w(source_work_item_id timezone next_run_at metadata)

  @spec execute(String.t(), map(), keyword()) :: {:ok, map() | [map()] | nil} | {:error, term()}
  def execute(tool, arguments, opts \\ [])

  def execute("scheduled_task.create", arguments, opts) do
    with :ok <- ensure_schema_ready(opts),
         {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace_id} <- workspace_id(args, opts),
         {:ok, agent_id} <- agent_id(args, opts),
         {:ok, instructions} <- required_string(args, "instructions"),
         {:ok, schedule} <- required_map(args, "schedule"),
         :ok <- NextRun.validate(schedule),
         {:ok, delivery} <- delivery(args),
         :ok <- verify_agent_workspace(agent_id, workspace_id, opts),
         {:ok, next_run_at} <- create_next_run_at(args, schedule, opts) do
      payload =
        args
        |> Map.take(@create_fields)
        |> Map.merge(%{
          "workspace_id" => workspace_id,
          "agent_id" => agent_id,
          "instructions" => instructions,
          "schedule" => schedule,
          "delivery" => delivery,
          "enabled" => Map.get(args, "enabled", true)
        })
        |> maybe_put("next_run_at", maybe_iso8601(next_run_at))

      repository(opts).create_task(payload, opts)
    end
  end

  def execute("scheduled_task.read", arguments, opts) do
    with :ok <- ensure_schema_ready(opts),
         {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace_id} <- workspace_id(args, opts),
         {:ok, scheduled_task_id} <- scheduled_task_id(args) do
      repository(opts).read_task(scheduled_task_id, workspace_id, opts)
    end
  end

  def execute("scheduled_task.list", arguments, opts) do
    with :ok <- ensure_schema_ready(opts),
         {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace_id} <- workspace_id(args, opts) do
      repository(opts).list_tasks(workspace_id, opts)
    end
  end

  def execute("scheduled_task.update", arguments, opts) do
    with :ok <- ensure_schema_ready(opts),
         {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace_id} <- workspace_id(args, opts),
         {:ok, scheduled_task_id} <- scheduled_task_id(args),
         {:ok, existing} when is_map(existing) <-
           repository(opts).read_task(scheduled_task_id, workspace_id, opts),
         {:ok, payload, changed_fields, resolved} <- update_payload(args, existing),
         :ok <- verify_update_agent_workspace(payload, workspace_id, opts) do
      expected_updated_at = if_updated_at(args)

      if changed_fields == [] do
        {:ok, Map.put(resolved, "changed_fields", [])}
      else
        update_opts =
          if is_binary(expected_updated_at) do
            Keyword.put(opts, :match_updated_at, expected_updated_at)
          else
            opts
          end

        existing["id"]
        |> then(&repository(opts).update_task(&1, payload, update_opts))
        |> apply_update_result(resolved, changed_fields, existing, workspace_id, expected_updated_at, opts)
      end
    else
      {:ok, nil} -> {:error, :scheduled_task_not_found}
      other -> other
    end
  end

  def execute("scheduled_task.delete", arguments, opts) do
    with :ok <- ensure_schema_ready(opts),
         {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace_id} <- workspace_id(args, opts),
         {:ok, scheduled_task_id} <- scheduled_task_id(args),
         {:ok, existing} when is_map(existing) <-
           repository(opts).read_task(scheduled_task_id, workspace_id, opts) do
      repository(opts).update_task(existing["id"], %{"enabled" => false}, opts)
    else
      {:ok, nil} -> {:error, :scheduled_task_not_found}
      other -> other
    end
  end

  def execute(tool, _arguments, _opts), do: {:error, {:unsupported_scheduled_task_tool, tool}}

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => "scheduled_task.create",
        "description" =>
          "Create a persisted scheduled agent message. Required: instructions and schedule. For a one-time message, use schedule={\"at\":\"2026-05-18T15:30:00Z\"}. For recurring wall-clock messages, use schedule={\"every\":\"day\",\"at\":\"09:00:00\"} or schedule={\"every\":\"week\",\"at\":\"09:00:00\"} plus timezone=\"America/New_York\"; next_run_at is inferred as the next matching occurrence. For cadence-only recurring schedules, use schedule={\"every\":\"hour\"} plus next_run_at as the first ISO-8601 occurrence. Supported recurring units are exactly hour, day, and week with interval 1. 30-minute/minute schedules, cron, monthly, and yearly schedules are not supported; if the user asks for every 30 minutes, explain that the current scheduler only supports hourly or less frequent cadence and create an hourly task only if they accept that.",
        "inputSchema" => create_schema()
      },
      %{
        "name" => "scheduled_task.read",
        "description" => "Read one scheduled task by id inside the current workspace.",
        "inputSchema" => id_schema()
      },
      %{
        "name" => "scheduled_task.update",
        "description" =>
          "Update an existing scheduled task. Only scheduledTaskId is required; omitted fields are unchanged. Explicit null clears nullable fields only (source_work_item_id, timezone, next_run_at, metadata) and is rejected for non-nullable fields. The result includes changed_fields. Pass if_updated_at from scheduled_task.read to reject the update if the row changed since it was read.",
        "inputSchema" => update_schema()
      },
      %{
        "name" => "scheduled_task.list",
        "description" => "List scheduled tasks visible in the current workspace.",
        "inputSchema" => workspace_schema()
      },
      %{
        "name" => "scheduled_task.delete",
        "description" => "Disable (soft-delete) a scheduled task by id while preserving run history.",
        "inputSchema" => id_schema()
      }
    ]
  end

  def tool_spec(name) do
    Enum.find(tool_specs(), &(&1["name"] == name)) ||
      raise ArgumentError, "unknown scheduled task tool #{inspect(name)}"
  end

  defp update_payload(args, existing) do
    provided =
      @update_fields
      |> Enum.filter(&Map.has_key?(args, &1))
      |> Enum.reduce(%{}, fn key, acc -> Map.put(acc, key, Map.get(args, key)) end)

    with :ok <- reject_invalid_nulls(provided),
         :ok <- validate_optional_schedule(provided),
         :ok <- validate_optional_delivery(provided),
         {:ok, provided} <- normalize_optional_next_run_at(provided),
         {:ok, resolved} <- resolve_metadata_update(provided, existing) do
      changed_fields = changed_fields(resolved, existing)
      payload = Map.take(resolved, changed_fields)

      {:ok, payload, changed_fields, Map.merge(existing, resolved)}
    end
  end

  defp reject_invalid_nulls(payload) do
    case Enum.find(payload, fn {key, value} -> is_nil(value) and key not in @nullable_update_fields end) do
      {key, nil} -> {:error, {:invalid_null, "#{key} is non-nullable"}}
      nil -> :ok
    end
  end

  defp changed_fields(resolved, existing) do
    resolved
    |> Map.keys()
    |> Enum.filter(&(Map.get(existing, &1) != Map.get(resolved, &1)))
  end

  defp resolve_metadata_update(%{"metadata" => metadata} = payload, existing) when is_map(metadata) do
    existing_metadata =
      case Map.get(existing, "metadata") do
        value when is_map(value) -> value
        _ -> %{}
      end

    {:ok, Map.put(payload, "metadata", Map.merge(existing_metadata, metadata))}
  end

  defp resolve_metadata_update(payload, _existing), do: {:ok, payload}

  defp if_updated_at(args) do
    case Map.get(args, "if_updated_at") do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp apply_update_result({:ok, row}, resolved, changed_fields, _existing, _workspace_id, _expected_updated_at, _opts)
       when is_map(row) do
    {:ok, resolved |> Map.merge(row) |> Map.put("changed_fields", changed_fields)}
  end

  defp apply_update_result({:ok, nil}, _resolved, _changed_fields, existing, workspace_id, expected_updated_at, opts)
       when is_binary(expected_updated_at) do
    resolve_stale_update(existing, workspace_id, expected_updated_at, opts)
  end

  defp apply_update_result({:ok, nil}, resolved, changed_fields, _existing, _workspace_id, _expected_updated_at, _opts) do
    {:ok, Map.put(resolved, "changed_fields", changed_fields)}
  end

  defp apply_update_result({:error, _reason} = error, _resolved, _changed_fields, _existing, _workspace_id, _expected_updated_at, _opts) do
    error
  end

  defp resolve_stale_update(existing, workspace_id, expected_updated_at, opts) do
    case repository(opts).read_task(existing["id"], workspace_id, opts) do
      {:ok, nil} ->
        {:error, :scheduled_task_not_found}

      {:ok, current} when is_map(current) ->
        {:error,
         {:stale_row,
          %{
            table: "scheduled_task",
            id: Map.get(current, "id") || Map.get(existing, "id"),
            workspace_id: Map.get(current, "workspace_id") || workspace_id,
            expected_updated_at: expected_updated_at,
            actual_updated_at: Map.get(current, "updated_at")
          }}}

      {:error, _reason} = error ->
        error
    end
  end

  defp validate_optional_schedule(%{"schedule" => schedule}) do
    with {:ok, schedule} <- required_map(%{"schedule" => schedule}, "schedule") do
      NextRun.validate(schedule)
    end
  end

  defp validate_optional_schedule(_payload), do: :ok

  defp validate_optional_delivery(%{"delivery" => delivery}) do
    case Delivery.validate_delivery(%{"delivery" => delivery}) do
      :ok -> :ok
      {:error, _reason} = error -> error
    end
  end

  defp validate_optional_delivery(_payload), do: :ok

  defp normalize_optional_next_run_at(%{"next_run_at" => _value} = payload) do
    case optional_iso8601(payload, "next_run_at") do
      {:ok, datetime} -> {:ok, Map.put(payload, "next_run_at", maybe_iso8601(datetime))}
      {:error, _reason} = error -> error
    end
  end

  defp normalize_optional_next_run_at(payload), do: {:ok, payload}

  defp delivery(args) do
    delivery = Map.get(args, "delivery", %{"kind" => Delivery.delivery_kind()})

    case Delivery.validate_delivery(%{"delivery" => delivery}) do
      :ok -> {:ok, delivery}
      {:error, _reason} = error -> error
    end
  end

  defp scheduled_task_id(args) do
    case Map.get(args, "scheduledTaskId") || Map.get(args, "scheduled_task_id") ||
           Map.get(args, "id") do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_argument, "scheduledTaskId"}}
    end
  end

  defp workspace_id(args, opts) do
    case Keyword.get(opts, :workspace_id) || Map.get(args, "workspace_id") do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_argument, "workspace_id"}}
    end
  end

  defp agent_id(args, opts) do
    case Map.get(args, "agent_id") || Keyword.get(opts, :agent_id) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_argument, "agent_id"}}
    end
  end

  defp verify_agent_workspace(agent_id, workspace_id, opts) do
    case repository(opts).agent_workspace_id(agent_id, opts) do
      {:ok, ^workspace_id} ->
        :ok

      {:ok, other_workspace_id} ->
        {:error, {:agent_workspace_mismatch, agent_id, other_workspace_id}}

      {:error, _reason} = error ->
        error
    end
  end

  defp verify_update_agent_workspace(%{"agent_id" => agent_id}, workspace_id, opts)
       when is_binary(agent_id) and agent_id != "" do
    verify_agent_workspace(agent_id, workspace_id, opts)
  end

  defp verify_update_agent_workspace(_payload, _workspace_id, _opts), do: :ok

  defp create_next_run_at(args, schedule, opts) do
    case optional_iso8601(args, "next_run_at") do
      {:ok, %DateTime{} = datetime} ->
        {:ok, datetime}

      {:ok, nil} ->
        NextRun.first_after(
          schedule,
          Keyword.get(opts, :now, DateTime.utc_now()),
          Map.get(args, "timezone")
        )

      {:error, _reason} = error ->
        error
    end
  end

  defp required_string(args, key) do
    case Map.get(args, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_argument, key}}
    end
  end

  defp required_map(args, key) do
    case Map.get(args, key) do
      value when is_map(value) -> {:ok, value}
      _ -> {:error, {:invalid_argument, key, "must be an object"}}
    end
  end

  defp optional_iso8601(args, key) do
    case Map.get(args, key) do
      nil ->
        {:ok, nil}

      value when is_binary(value) ->
        case Time.parse_iso8601(value) do
          %DateTime{} = datetime -> {:ok, datetime}
          nil -> {:error, {:invalid_argument, key, "must be ISO-8601 or null"}}
        end

      _ ->
        {:error, {:invalid_argument, key, "must be ISO-8601 or null"}}
    end
  end

  defp normalize_arguments(arguments) when is_map(arguments) do
    {:ok, Map.new(arguments, fn {key, value} -> {to_string(key), value} end)}
  end

  defp normalize_arguments(_arguments), do: {:error, :invalid_arguments}
  defp repository(opts), do: Keyword.get(opts, :repository, Repository)

  defp ensure_schema_ready(opts) do
    case repository(opts) do
      Repository ->
        if Repository.schema_ready?(), do: :ok, else: {:error, Repository.schema_error()}

      _custom_repository ->
        :ok
    end
  end

  defp maybe_iso8601(%DateTime{} = datetime), do: Time.to_iso8601(datetime)
  defp maybe_iso8601(nil), do: nil
  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp create_schema do
    base_schema()
    |> put_required(~w(instructions schedule))
    |> put_properties(common_properties())
  end

  defp update_schema do
    id_schema()
    |> put_properties(
      common_properties()
      |> Map.drop(["workspace_id"])
      |> Map.put(
        "if_updated_at",
        nullable_string_schema("Optional optimistic concurrency guard. Use the updated_at value returned by scheduled_task.read; stale values reject the update.")
      )
    )
  end

  defp id_schema do
    workspace_schema()
    |> put_required(["scheduledTaskId"])
    |> put_properties(%{"scheduledTaskId" => string_schema("Scheduled task UUID.")})
  end

  defp workspace_schema do
    base_schema()
    |> put_properties(%{"workspace_id" => string_schema("Workspace database UUID.")})
  end

  defp base_schema do
    %{"type" => "object", "additionalProperties" => false, "required" => [], "properties" => %{}}
  end

  defp common_properties do
    %{
      "workspace_id" => string_schema("Workspace database UUID."),
      "agent_id" => string_schema("Target agent UUID."),
      "source_work_item_id" => nullable_string_schema("Optional provenance work item UUID."),
      "instructions" => string_schema("Free-text instructions delivered to the agent."),
      "enabled" => %{"type" => "boolean"},
      "schedule" => %{
        "type" => "object",
        "description" =>
          "One-time: {\"at\":\"<ISO-8601 datetime>\"}. Recurring wall-clock: {\"every\":\"day|week\",\"at\":\"HH:MM:SS\"} with timezone. Cadence-only recurring: {\"every\":\"hour|day|week\"} plus next_run_at. Only interval 1 is supported; minute/30-minute and cron schedules are not supported.",
        "additionalProperties" => true
      },
      "timezone" => nullable_string_schema("IANA timezone for day/week wall-clock schedule calculation, for example America/New_York."),
      "next_run_at" => nullable_string_schema("First due occurrence as an ISO-8601 timestamp. Required for cadence-only recurring schedules without schedule.at."),
      "delivery" => %{
        "type" => "object",
        "additionalProperties" => false,
        "properties" => %{"kind" => %{"type" => "string", "enum" => [Delivery.delivery_kind()]}},
        "required" => ["kind"]
      },
      "metadata" => %{"type" => ["object", "null"], "additionalProperties" => true}
    }
  end

  defp put_required(schema, required), do: Map.put(schema, "required", required)

  defp put_properties(schema, properties),
    do: Map.update!(schema, "properties", &Map.merge(&1, properties))

  defp string_schema(description), do: %{"type" => "string", "description" => description}

  defp nullable_string_schema(description),
    do: %{"type" => ["string", "null"], "description" => description}
end
