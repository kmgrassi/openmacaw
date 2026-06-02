defmodule SymphonyElixir.Planner.DatabaseTools.Updates do
  @moduledoc false

  @spec plan_update_patch(map(), [String.t()], [String.t()]) :: {:ok, map()} | {:error, tuple()}
  def plan_update_patch(args, update_fields, non_nullable_fields) do
    with :ok <- reject_invalid_update_nulls(args, non_nullable_fields),
         :ok <- validate_plan_metadata_patch(args) do
      update_payload(args, update_fields)
    end
  end

  @spec validate_task_update_args(map(), [String.t()]) :: :ok | {:error, tuple()}
  def validate_task_update_args(args, non_nullable_fields) do
    reject_invalid_update_nulls(args, non_nullable_fields)
  end

  @spec task_update_payload(map(), map(), [String.t()], [String.t()]) ::
          {:ok, map(), [String.t()], map()} | {:error, tuple()}
  def task_update_payload(args, existing, update_fields, non_nullable_fields) do
    with :ok <- validate_task_update_args(args, non_nullable_fields),
         {:ok, requested_payload} <- task_update_requested_payload(args, update_fields) do
      resolved_payload = resolve_task_update_payload(requested_payload, existing)
      changed_fields = changed_fields(resolved_payload, existing)
      payload = Map.take(resolved_payload, changed_fields)
      resolved_row = Map.merge(existing, payload)

      {:ok, payload, changed_fields, resolved_row}
    end
  end

  @spec changed_update_payload(map(), map(), [String.t()]) :: {:ok, map(), [String.t()]}
  def changed_update_payload(existing, patch, field_order) do
    resolved_patch = resolve_update_patch(existing, patch)

    changed_fields =
      Enum.filter(field_order, fn key ->
        Map.has_key?(resolved_patch, key) and Map.get(existing, key) != Map.get(resolved_patch, key)
      end)

    payload = Map.take(resolved_patch, changed_fields)

    {:ok, payload, changed_fields}
  end

  defp reject_invalid_update_nulls(args, fields) do
    case Enum.find(fields, &(Map.has_key?(args, &1) and is_nil(Map.get(args, &1)))) do
      nil -> :ok
      field -> {:error, {:invalid_null, "#{field} is non-nullable"}}
    end
  end

  defp validate_plan_metadata_patch(args) do
    cond do
      not Map.has_key?(args, "metadata") -> :ok
      is_map(Map.get(args, "metadata")) -> :ok
      true -> {:error, {:invalid_argument, "metadata", "must be an object"}}
    end
  end

  defp update_payload(args, allowed_fields) do
    payload =
      allowed_fields
      |> Enum.filter(&Map.has_key?(args, &1))
      |> Enum.reduce(%{}, fn key, acc -> Map.put(acc, key, Map.get(args, key)) end)

    if map_size(payload) == 0 do
      {:error, {:missing_update_fields, allowed_fields}}
    else
      {:ok, payload}
    end
  end

  defp task_update_requested_payload(args, update_fields) do
    requested_payload =
      update_fields
      |> Enum.filter(&Map.has_key?(args, &1))
      |> Enum.reduce(%{}, fn key, acc ->
        Map.put(acc, task_update_payload_key(key), Map.get(args, key))
      end)

    {:ok, requested_payload}
  end

  defp resolve_task_update_payload(%{"metadata" => metadata} = payload, existing) when is_map(metadata) do
    existing_metadata =
      case Map.get(existing, "metadata") do
        value when is_map(value) -> value
        _ -> %{}
      end

    Map.put(payload, "metadata", Map.merge(existing_metadata, metadata))
  end

  defp resolve_task_update_payload(payload, _existing), do: payload

  defp changed_fields(payload, existing) do
    payload
    |> Map.keys()
    |> Enum.filter(&(Map.get(payload, &1) != Map.get(existing, &1)))
    |> Enum.sort()
  end

  defp resolve_update_patch(existing, patch) do
    if Map.has_key?(patch, "metadata") do
      Map.update!(patch, "metadata", fn metadata_patch ->
        existing
        |> existing_metadata()
        |> Map.merge(metadata_patch)
      end)
    else
      patch
    end
  end

  defp existing_metadata(existing) do
    case Map.get(existing, "metadata") do
      metadata when is_map(metadata) -> metadata
      _ -> %{}
    end
  end

  defp task_update_payload_key("name"), do: "title"
  defp task_update_payload_key("status"), do: "state"
  defp task_update_payload_key(key), do: key
end
