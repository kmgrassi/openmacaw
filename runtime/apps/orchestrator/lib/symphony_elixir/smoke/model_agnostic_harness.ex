defmodule SymphonyElixir.Smoke.ModelAgnosticHarness do
  @moduledoc """
  Deterministic smoke harness for the model-agnostic agent handoff.

  The harness intentionally consumes API-shaped fixture data instead of calling
  live providers. It verifies the runtime-side contract for the cross-provider
  path:

  * a planning execution profile can emit normalized plan/task events;
  * approved tasks are the only tasks handed to coding;
  * the coding handoff carries a separate execution profile;
  * credentials and provider secrets are not present in the fixture envelope.
  """

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Planning.PlanHandoff
  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.WorkItem

  @secret_keys ~w(
    api_key
    apikey
    authorization
    bearer
    client_secret
    credential_value
    password
    refresh_token
    secret
    secret_value
    token
  )

  @required_profile_fields ~w(agent_id workspace_id role runner_kind provider model credential_ref tool_profile)

  @type summary :: %{
          scenario: String.t() | nil,
          planning: map(),
          approval: map(),
          coding: map()
        }

  @doc """
  Loads and runs a model-agnostic smoke fixture from disk.
  """
  @spec run_fixture(Path.t()) :: {:ok, summary()} | {:error, term()}
  def run_fixture(path) when is_binary(path) do
    with {:ok, body} <- File.read(path),
         {:ok, fixture} <- Jason.decode(body) do
      run(fixture)
    end
  end

  @doc """
  Runs a decoded smoke fixture.
  """
  @spec run(map()) :: {:ok, summary()} | {:error, term()}
  def run(fixture) when is_map(fixture) do
    with :ok <- reject_secrets(fixture),
         {:ok, planning_profile} <- fetch_profile(fixture, "planning_start", "planning"),
         {:ok, coding_profile} <- fetch_profile(fixture, "coding_dispatch", "coding"),
         {:ok, events} <- normalize_events(Map.get(fixture, "planning_events", [])),
         {:ok, plan} <- extract_plan(events),
         {:ok, approved_ids} <- approved_task_ids(fixture),
         :ok <- validate_approval(plan, approved_ids),
         {:ok, work_items} <- coding_work_items(fixture),
         :ok <- validate_handoff(work_items, approved_ids),
         {:ok, handoff} <- validate_launch_handoff(fixture, coding_profile, plan, approved_ids) do
      {:ok,
       %{
         scenario: Map.get(fixture, "scenario"),
         planning: %{
           runner_kind: planning_profile["runner_kind"],
           provider: planning_profile["provider"],
           model: planning_profile["model"],
           plan_id: plan["id"],
           task_count: length(Map.get(plan, "tasks", []))
         },
         approval: %{
           approved_task_ids: approved_ids,
           approved_task_count: length(approved_ids)
         },
         coding: %{
           runner_kind: coding_profile["runner_kind"],
           provider: coding_profile["provider"],
           model: coding_profile["model"],
           handoff_count: length(work_items),
           approved_plan_id: handoff["approved_plan_id"],
           selected_task_ids: Map.get(handoff, "selected_task_ids", []),
           work_item_identifiers: Enum.map(work_items, & &1.identifier)
         }
       }}
    end
  end

  defp fetch_profile(fixture, envelope_key, expected_role) do
    profile =
      fixture
      |> Map.get(envelope_key, %{})
      |> Map.get("execution_profile")

    with :ok <- validate_profile(profile, expected_role) do
      {:ok, profile}
    end
  end

  defp validate_profile(profile, expected_role) when is_map(profile) do
    missing =
      @required_profile_fields
      |> Enum.reject(&(is_binary(Map.get(profile, &1)) and Map.get(profile, &1) != ""))

    cond do
      missing != [] ->
        {:error, {:missing_execution_profile_fields, expected_role, missing}}

      profile["role"] != expected_role ->
        {:error, {:unexpected_execution_profile_role, expected_role, profile["role"]}}

      true ->
        :ok
    end
  end

  defp validate_profile(_profile, expected_role),
    do: {:error, {:missing_execution_profile, expected_role}}

  defp normalize_events(events) when is_list(events) do
    Enum.reduce_while(events, {:ok, []}, fn event, {:ok, acc} ->
      case Contract.normalize_event(event) do
        {:ok, normalized} -> {:cont, {:ok, [normalized | acc]}}
        {:error, reason} -> {:halt, {:error, {:invalid_normalized_event, reason, event}}}
      end
    end)
    |> case do
      {:ok, normalized} -> {:ok, Enum.reverse(normalized)}
      error -> error
    end
  end

  defp normalize_events(_events), do: {:error, :planning_events_must_be_a_list}

  defp extract_plan(events) do
    case direct_plan(events) || review_event_plan(events) do
      %{"id" => id, "tasks" => tasks} when is_binary(id) and is_list(tasks) ->
        {:ok, %{"id" => id, "tasks" => tasks}}

      _other ->
        {:error, :missing_plan_create_event}
    end
  end

  defp direct_plan(events) do
    Enum.find_value(events, fn
      %{
        event: :tool_call_completed,
        payload: %{"tool_name" => "plan.create", "result" => %{"plan" => plan}}
      } ->
        plan

      _event ->
        nil
    end)
  end

  defp review_event_plan(events) do
    review_events = Enum.flat_map(events, &tool_review_events/1)

    plan =
      Enum.find_value(review_events, fn
        %{"type" => "planner.plan.created", "payload" => %{"plan_id" => plan_id} = payload}
        when is_binary(plan_id) ->
          payload

        _event ->
          nil
      end)

    if plan do
      plan_id = plan["plan_id"]

      tasks =
        review_events
        |> Enum.flat_map(fn
          %{
            "type" => "planner.task.created",
            "payload" => %{"task_id" => task_id, "plan_id" => ^plan_id} = payload
          }
          when is_binary(task_id) ->
            [
              %{
                "id" => task_id,
                "title" => payload["name"],
                "description" => payload["description"]
              }
            ]

          _event ->
            []
        end)

      %{"id" => plan_id, "tasks" => tasks}
    end
  end

  defp tool_review_events(
         %{event: :tool_call_completed, payload: %{"params" => %{"tool" => tool}}} = event
       )
       when tool in ["plan.create", "task.create"] do
    event
    |> first_present([:details, "details"])
    |> Map.get("output")
    |> decode_tool_output()
    |> Map.get("_review_events", [])
    |> case do
      events when is_list(events) -> events
      _other -> []
    end
  end

  defp tool_review_events(_event), do: []

  defp first_present(map, keys) do
    Enum.find_value(keys, fn key ->
      case Map.fetch(map, key) do
        {:ok, nil} -> nil
        {:ok, value} -> value
        :error -> nil
      end
    end) || %{}
  end

  defp decode_tool_output(output) when is_binary(output) do
    case Jason.decode(output) do
      {:ok, decoded} when is_map(decoded) -> decoded
      _other -> %{}
    end
  end

  defp decode_tool_output(output) when is_map(output), do: output
  defp decode_tool_output(_output), do: %{}

  defp approved_task_ids(fixture) do
    ids =
      fixture
      |> Map.get("approval", %{})
      |> Map.get("approved_task_ids")

    if is_list(ids) and Enum.all?(ids, &is_binary/1) do
      {:ok, ids}
    else
      {:error, :approval_requires_approved_task_ids}
    end
  end

  defp validate_approval(plan, approved_ids) do
    task_ids =
      plan
      |> Map.get("tasks", [])
      |> Enum.map(&Map.get(&1, "id"))
      |> MapSet.new()

    unknown_ids = Enum.reject(approved_ids, &MapSet.member?(task_ids, &1))

    case unknown_ids do
      [] -> :ok
      _ -> {:error, {:approval_references_unknown_tasks, unknown_ids}}
    end
  end

  defp coding_work_items(fixture) do
    work_items =
      fixture
      |> Map.get("coding_dispatch", %{})
      |> Map.get("work_items")

    if is_list(work_items) do
      {:ok, Enum.map(work_items, &work_item!/1)}
    else
      {:error, :coding_dispatch_requires_work_items}
    end
  rescue
    error in ArgumentError -> {:error, {:invalid_coding_work_item, Exception.message(error)}}
  end

  defp work_item!(item) when is_map(item) do
    task_id = Map.get(item, "task_id")
    identifier = Map.get(item, "identifier")

    unless is_binary(task_id) and task_id != "" and is_binary(identifier) and identifier != "" do
      raise ArgumentError, "coding work item requires task_id and identifier"
    end

    %WorkItem{
      id: Map.get(item, "id"),
      identifier: identifier,
      title: Map.get(item, "title"),
      description: Map.get(item, "description"),
      state: Map.get(item, "state"),
      source: Map.get(item, "source", "api_fixture"),
      runner_type: Map.get(item, "runner_type"),
      plan_id: Map.get(item, "plan_id"),
      task_id: task_id,
      labels: Map.get(item, "labels", []),
      metadata: Map.get(item, "metadata", %{})
    }
  end

  defp work_item!(_item), do: raise(ArgumentError, "coding work item must be an object")

  defp validate_handoff(work_items, approved_ids) do
    handed_off_ids = Enum.map(work_items, & &1.task_id)

    cond do
      handed_off_ids == [] ->
        {:error, :coding_handoff_requires_at_least_one_work_item}

      Enum.sort(handed_off_ids) != Enum.sort(approved_ids) ->
        {:error, {:coding_handoff_does_not_match_approval, handed_off_ids, approved_ids}}

      true ->
        :ok
    end
  end

  defp validate_launch_handoff(fixture, coding_profile, plan, approved_ids) do
    launch_params =
      fixture
      |> Map.get("coding_dispatch", %{})
      |> Map.get("launch_params")

    agent = %Agent{
      id: coding_profile["agent_id"],
      workspace_id: coding_profile["workspace_id"],
      type: "coding"
    }

    with {:ok, handoff} <- normalize_launch_handoff(agent, launch_params),
         :ok <- validate_launch_plan(handoff, plan),
         :ok <- validate_launch_tasks(handoff, approved_ids) do
      {:ok, handoff}
    end
  end

  defp normalize_launch_handoff(_agent, nil),
    do: {:error, :coding_dispatch_requires_launch_params}

  defp normalize_launch_handoff(agent, launch_params) when is_map(launch_params) do
    case PlanHandoff.validate_launch(agent, launch_params) do
      {:ok, %{} = handoff} -> {:ok, handoff}
      {:ok, nil} -> {:error, :coding_dispatch_requires_planner_handoff}
      {:error, reason} -> {:error, {:invalid_coding_launch_handoff, reason}}
    end
  end

  defp normalize_launch_handoff(_agent, _launch_params),
    do: {:error, :coding_dispatch_launch_params_must_be_object}

  defp validate_launch_plan(%{"approved_plan_id" => plan_id}, %{"id" => plan_id}), do: :ok

  defp validate_launch_plan(%{"approved_plan_id" => other}, %{"id" => plan_id}),
    do: {:error, {:coding_launch_plan_mismatch, other, plan_id}}

  defp validate_launch_plan(_handoff, %{"id" => plan_id}),
    do: {:error, {:coding_launch_missing_approved_plan_id, plan_id}}

  defp validate_launch_tasks(handoff, approved_ids) do
    task_ids = Map.get(handoff, "selected_task_ids", [])

    if Enum.sort(task_ids) == Enum.sort(approved_ids) do
      :ok
    else
      {:error, {:coding_launch_task_mismatch, task_ids, approved_ids}}
    end
  end

  defp reject_secrets(value), do: reject_secrets(value, [])

  defp reject_secrets(map, path) when is_map(map) do
    Enum.reduce_while(map, :ok, fn {key, value}, :ok ->
      normalized_key = key |> to_string() |> String.downcase()
      next_path = path ++ [to_string(key)]

      if normalized_key in @secret_keys do
        {:halt, {:error, {:secret_field_present, Enum.join(next_path, ".")}}}
      else
        case reject_secrets(value, next_path) do
          :ok -> {:cont, :ok}
          error -> {:halt, error}
        end
      end
    end)
  end

  defp reject_secrets(list, path) when is_list(list) do
    list
    |> Enum.with_index()
    |> Enum.reduce_while(:ok, fn {value, index}, :ok ->
      case reject_secrets(value, path ++ [Integer.to_string(index)]) do
        :ok -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp reject_secrets(_value, _path), do: :ok
end
