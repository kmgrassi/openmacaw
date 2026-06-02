defmodule SymphonyElixir.Orchestrator.ExecutionSlot do
  @moduledoc """
  Runtime-internal execution slot capability contract.

  A slot represents a host, container, or future runtime unit that can accept an
  isolated task workspace. Reuse is eligible only when all hard safety gates
  match: workspace boundary, requested runner kind, execution target, capacity,
  and repository cache identity. This module only classifies eligibility; later
  selection work can rank eligible warm slots against cold fallback behavior.
  """

  @enforce_keys [:id, :workspace_id, :runner_kinds, :execution_target, :available_slots]
  defstruct [
    :id,
    :workspace_id,
    :execution_target,
    available_slots: 0,
    runner_kinds: [],
    cached_repo_ids: MapSet.new(),
    cache_state: %{},
    metadata: %{}
  ]

  @type cache_state :: :warm | :cold | :unknown | String.t() | map()

  @type t :: %__MODULE__{
          id: String.t(),
          workspace_id: String.t(),
          runner_kinds: [String.t()],
          execution_target: String.t(),
          available_slots: non_neg_integer(),
          cached_repo_ids: MapSet.t(String.t()),
          cache_state: cache_state(),
          metadata: map()
        }

  @type request :: %{
          required(:workspace_id) => String.t(),
          required(:runner_kind) => String.t(),
          required(:execution_target) => String.t(),
          required(:repo_id) => String.t()
        }

  @type ineligible_reason ::
          :workspace_mismatch
          | :runner_kind_mismatch
          | :execution_target_mismatch
          | :no_capacity
          | :repo_cache_miss

  @type eligibility :: {:eligible, t()} | {:ineligible, ineligible_reason(), t()}

  @spec new(map() | keyword()) :: t()
  def new(attrs) do
    attrs = Map.new(attrs)

    struct!(__MODULE__, %{
      id: required_string!(attrs, :id),
      workspace_id: required_string!(attrs, :workspace_id),
      runner_kinds: string_list(value(attrs, :runner_kinds, [])),
      execution_target: required_string!(attrs, :execution_target),
      available_slots: available_slots(value(attrs, :available_slots, 0)),
      cached_repo_ids: repo_id_set(value(attrs, :cached_repo_ids, [])),
      cache_state: value(attrs, :cache_state, %{}),
      metadata: value(attrs, :metadata, %{})
    })
  end

  @spec eligible?(t(), request()) :: boolean()
  def eligible?(%__MODULE__{} = slot, %{} = request) do
    match?({:eligible, ^slot}, eligibility(slot, request))
  end

  @spec eligibility(t(), request()) :: eligibility()
  def eligibility(%__MODULE__{} = slot, %{} = request) do
    cond do
      slot.workspace_id != value(request, :workspace_id) ->
        {:ineligible, :workspace_mismatch, slot}

      value(request, :runner_kind) not in slot.runner_kinds ->
        {:ineligible, :runner_kind_mismatch, slot}

      slot.execution_target != value(request, :execution_target) ->
        {:ineligible, :execution_target_mismatch, slot}

      slot.available_slots <= 0 ->
        {:ineligible, :no_capacity, slot}

      not MapSet.member?(slot.cached_repo_ids, value(request, :repo_id)) ->
        {:ineligible, :repo_cache_miss, slot}

      true ->
        {:eligible, slot}
    end
  end

  @spec eligible_slots([t()], request()) :: [t()]
  def eligible_slots(slots, %{} = request) when is_list(slots) do
    slots
    |> Enum.filter(&eligible?(&1, request))
  end

  defp required_string!(attrs, key) do
    case attrs |> value(key) |> normalize_string() do
      nil -> raise ArgumentError, "execution slot requires #{key}"
      value -> value
    end
  end

  defp value(attrs, key, default \\ nil) when is_map(attrs) and is_atom(key) do
    Map.get(attrs, key) || Map.get(attrs, Atom.to_string(key), default)
  end

  defp string_list(values) when is_list(values) do
    values
    |> Enum.map(&normalize_string/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp string_list(_values), do: []

  defp repo_id_set(%MapSet{} = repo_ids), do: repo_ids

  defp repo_id_set(repo_ids) when is_list(repo_ids) do
    repo_ids
    |> string_list()
    |> MapSet.new()
  end

  defp repo_id_set(_repo_ids), do: MapSet.new()

  defp available_slots(value) when is_integer(value) and value > 0, do: value
  defp available_slots(_value), do: 0

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(_value), do: nil
end
