defmodule SymphonyElixir.Orchestrator.WorkerSlotPolicy do
  @moduledoc """
  Safety policy for reusing a running worker/container slot.

  A slot is reusable only when the runner, workspace/customer boundary,
  credential/resource scope, disk headroom, and active-session count all match
  the incoming work item requirements.
  """

  defmodule Slot do
    @moduledoc false

    @enforce_keys [:id]
    defstruct [
      :id,
      :workspace_id,
      :customer_id,
      :execution_target,
      :available_disk_bytes,
      :min_available_disk_bytes,
      :active_session_count,
      :max_active_session_count,
      runner_kinds: [],
      credential_ids: [],
      resource_ids: []
    ]
  end

  defmodule Request do
    @moduledoc false

    defstruct [
      :workspace_id,
      :customer_id,
      :runner_kind,
      required_credential_ids: [],
      required_resource_ids: []
    ]
  end

  @type denial_reason ::
          :invalid_slot
          | :workspace_boundary_mismatch
          | :customer_boundary_mismatch
          | :runner_not_supported_on_warm_slot
          | :missing_required_credentials
          | :missing_required_resources
          | :insufficient_disk_capacity
          | :warm_repo_slot_full

  @spec reusable?(Slot.t(), Request.t()) :: :ok | {:error, denial_reason()}
  def reusable?(%Slot{} = slot, %Request{} = request) do
    cond do
      blank?(slot.id) ->
        {:error, :invalid_slot}

      boundary_mismatch?(slot.workspace_id, request.workspace_id) ->
        {:error, :workspace_boundary_mismatch}

      boundary_mismatch?(slot.customer_id, request.customer_id) ->
        {:error, :customer_boundary_mismatch}

      !runner_supported?(slot.runner_kinds, request.runner_kind) ->
        {:error, :runner_not_supported_on_warm_slot}

      missing_required?(slot.credential_ids, request.required_credential_ids) ->
        {:error, :missing_required_credentials}

      missing_required?(slot.resource_ids, request.required_resource_ids) ->
        {:error, :missing_required_resources}

      !disk_capacity_available?(slot) ->
        {:error, :insufficient_disk_capacity}

      !active_session_available?(slot) ->
        {:error, :warm_repo_slot_full}

      true ->
        :ok
    end
  end

  def reusable?(_slot, _request), do: {:error, :invalid_slot}

  @spec available_session_count(Slot.t()) :: non_neg_integer() | :unbounded
  def available_session_count(%Slot{max_active_session_count: max})
      when not is_integer(max) or max <= 0,
      do: :unbounded

  def available_session_count(%Slot{} = slot) do
    max(slot.max_active_session_count - count(slot.active_session_count), 0)
  end

  defp boundary_mismatch?(slot_value, request_value) do
    present?(slot_value) and present?(request_value) and slot_value != request_value
  end

  defp runner_supported?(_runner_kinds, runner_kind) when not is_binary(runner_kind) or runner_kind == "",
    do: true

  defp runner_supported?(runner_kinds, runner_kind) when is_list(runner_kinds) do
    runner_kind in normalize_list(runner_kinds)
  end

  defp runner_supported?(_runner_kinds, _runner_kind), do: false

  defp missing_required?(_available, []), do: false

  defp missing_required?(available, required) when is_list(available) and is_list(required) do
    available_set = available |> normalize_list() |> MapSet.new()

    required
    |> normalize_list()
    |> Enum.any?(&(not MapSet.member?(available_set, &1)))
  end

  defp missing_required?(_available, required), do: normalize_list(required) != []

  defp disk_capacity_available?(%Slot{
         available_disk_bytes: available,
         min_available_disk_bytes: minimum
       })
       when is_integer(available) and is_integer(minimum) and minimum > 0,
       do: available >= minimum

  defp disk_capacity_available?(_slot), do: true

  defp active_session_available?(%Slot{} = slot), do: available_session_count(slot) != 0

  defp normalize_list(values) when is_list(values) do
    values
    |> Enum.map(&normalize_string/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp normalize_list(value), do: normalize_list([value])

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(value) when is_atom(value), do: value |> Atom.to_string() |> normalize_string()
  defp normalize_string(_value), do: nil

  defp count(value) when is_integer(value) and value > 0, do: value
  defp count(_value), do: 0

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false

  defp blank?(value), do: !present?(value)
end
