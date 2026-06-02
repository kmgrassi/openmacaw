defmodule SymphonyElixir.Planning.PlanHandoff do
  @moduledoc """
  Normalizes the explicit review-to-coding handoff contract.

  Planner output may propose a plan and tasks, but coding launches that are
  triggered from planner output must carry reviewed plan/task IDs. This module
  keeps that boundary out of prompt text and in the runtime API.
  """

  alias SymphonyElixir.AgentInventory.Agent

  @planner_sources ~w(planner planning plan_review)

  @type t :: %{
          optional(String.t()) => String.t() | [String.t()]
        }

  @spec validate_launch(Agent.t(), map() | nil) :: {:ok, t() | nil} | {:error, term()}
  def validate_launch(%Agent{} = agent, params) do
    params = normalize_map(params)

    cond do
      not Agent.coding?(agent) ->
        {:ok, nil}

      planner_launch?(params) ->
        validate_required(params)

      true ->
        {:ok, nil}
    end
  end

  @spec review_event(String.t(), map(), map()) :: map() | nil
  def review_event("plan.create", row, args) when is_map(row) do
    %{
      "type" => "planner.plan.created",
      "payload" => %{
        "plan_id" => Map.get(row, "id"),
        "workspace_id" => Map.get(row, "workspace_id") || Map.get(args, "workspace_id"),
        "name" => Map.get(row, "name") || Map.get(args, "name"),
        "description" => Map.get(row, "description") || Map.get(args, "description")
      }
    }
  end

  def review_event("task.create", row, args) when is_map(row) do
    %{
      "type" => "planner.task.created",
      "payload" => %{
        "task_id" => Map.get(row, "id"),
        "plan_id" => Map.get(row, "plan_id") || Map.get(args, "plan_id"),
        "workspace_id" => Map.get(row, "workspace_id") || Map.get(args, "workspace_id"),
        "name" => Map.get(row, "title") || Map.get(row, "name") || Map.get(args, "name"),
        "description" => Map.get(row, "description") || Map.get(args, "description"),
        "evidence" => evidence_from(row, args)
      }
    }
  end

  def review_event(_tool, _row, _args), do: nil

  defp validate_required(params) do
    case explicit_handoff(params) do
      {:ok, handoff} -> {:ok, handoff}
      :error -> {:error, :explicit_plan_handoff_required}
    end
  end

  defp explicit_handoff(params) do
    plan_id = first_string(params, ["approved_plan_id", "plan_id"])
    task_ids = string_list(first_value(params, ["selected_task_ids", "task_ids", "task_id"]))

    if plan_id || task_ids != [] do
      {:ok,
       %{}
       |> maybe_put("approved_plan_id", plan_id)
       |> maybe_put("selected_task_ids", task_ids)
       |> Map.put("source", "planner")}
    else
      :error
    end
  end

  defp planner_launch?(params) do
    params
    |> first_string(["source", "launch_source", "from"])
    |> case do
      source when source in @planner_sources ->
        true

      _ ->
        truthy?(first_value(params, ["from_planner", "planner_output", "requires_plan_handoff"]))
    end
  end

  defp normalize_map(%{} = params) do
    nested =
      case Map.get(params, "handoff") || Map.get(params, :handoff) do
        %{} = handoff -> normalize_map(handoff)
        _ -> %{}
      end

    params
    |> Map.new(fn {key, value} -> {to_string(key), value} end)
    |> Map.merge(nested)
  end

  defp normalize_map(_params), do: %{}

  defp first_value(params, keys) do
    Enum.find_value(keys, fn key ->
      value = Map.get(params, key)
      unless blank?(value), do: value
    end)
  end

  defp first_string(params, keys) do
    params
    |> first_value(keys)
    |> normalize_string()
  end

  defp string_list(value) when is_list(value) do
    value
    |> Enum.map(&normalize_string/1)
    |> Enum.reject(&is_nil/1)
  end

  defp string_list(value) do
    case normalize_string(value) do
      nil -> []
      string -> [string]
    end
  end

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(_value), do: nil

  defp truthy?(value), do: value in [true, "true", "1", "yes"]

  defp blank?(value) when is_binary(value), do: is_nil(normalize_string(value))
  defp blank?([]), do: true
  defp blank?(nil), do: true
  defp blank?(_value), do: false

  defp evidence_from(row, args) do
    Enum.find_value([Map.get(row, "metadata"), Map.get(args, "metadata")], [], fn
      %{"evidence" => evidence} when is_list(evidence) -> evidence
      %{evidence: evidence} when is_list(evidence) -> evidence
      _ -> nil
    end)
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, _key, []), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
