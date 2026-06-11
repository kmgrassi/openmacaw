defmodule SymphonyElixir.Cutover do
  @moduledoc """
  Walks execution-profile fallback chains for cutover-eligible provider calls.

  Runner call sites supply the provider invocation as `call_fn`; this module
  owns chain ordering, model-tier floor enforcement, cooldown skipping, and the
  decision object returned to callers.
  """

  alias SymphonyElixir.Cutover.Cooldown
  alias SymphonyElixir.ModelTiers

  defmodule CutoverLink do
    @moduledoc "A single primary or fallback provider target."

    @enforce_keys [:provider]
    defstruct [
      :workspace_id,
      :agent_id,
      :provider,
      :model,
      :credential_ref,
      :credential_id,
      :position,
      source: :fallback
    ]

    @type t :: %__MODULE__{
            workspace_id: String.t() | nil,
            agent_id: String.t() | nil,
            provider: String.t(),
            model: String.t() | nil,
            credential_ref: term(),
            credential_id: String.t() | nil,
            position: non_neg_integer() | nil,
            source: :primary | :fallback
          }
  end

  defmodule CutoverDecision do
    @moduledoc "Decision summary for a single cutover walk."

    defstruct [
      :workspace_id,
      :agent_id,
      :work_item_id,
      :from_provider,
      :from_model,
      :from_credential_id,
      :to_provider,
      :to_model,
      :to_credential_id,
      :trigger_error_code,
      :trigger_status_code,
      :outcome,
      :elapsed_ms,
      attempts: [],
      skipped: []
    ]

    @type t :: %__MODULE__{
            workspace_id: String.t() | nil,
            agent_id: String.t() | nil,
            work_item_id: String.t() | nil,
            from_provider: String.t() | nil,
            from_model: String.t() | nil,
            from_credential_id: String.t() | nil,
            to_provider: String.t() | nil,
            to_model: String.t() | nil,
            to_credential_id: String.t() | nil,
            trigger_error_code: String.t() | nil,
            trigger_status_code: integer() | nil,
            outcome: String.t() | nil,
            elapsed_ms: non_neg_integer() | nil,
            attempts: [map()],
            skipped: [map()]
          }
  end

  @type profile :: %{optional(String.t() | atom()) => term()}

  @spec walk(profile(), map(), (CutoverLink.t() -> {:ok, term()} | {:error, term()})) ::
          {:ok, term(), CutoverDecision.t()}
          | {:error, :exhausted | :floor_exhausted | {:non_retryable, term()}, CutoverDecision.t()}
  def walk(profile, context, call_fn) when is_map(profile) and is_map(context) and is_function(call_fn, 1) do
    started_at = monotonic_ms()
    profile = normalize_keys(profile)
    context = normalize_keys(context)
    floor = normalize_string(Map.get(profile, "model_tier_floor")) || "any"

    state = %{
      context: context,
      started_at: started_at,
      attempts: [],
      skipped: [],
      first_failure: nil,
      floor_skipped?: false
    }

    profile
    |> chain()
    |> walk_chain(floor, call_fn, state)
  end

  defp walk_chain([], _floor, _call_fn, state) do
    floor_only_exhaustion? = state.floor_skipped? and state.attempts == []
    outcome = if floor_only_exhaustion?, do: "escalated_floor", else: "escalated_exhausted"
    reason = if floor_only_exhaustion?, do: :floor_exhausted, else: :exhausted
    {:error, reason, decision(state, nil, outcome)}
  end

  defp walk_chain([link | rest], floor, call_fn, state) do
    cond do
      below_floor?(link, floor) ->
        skip = skip_record(link, "below_model_tier_floor", model_tier: ModelTiers.tier_of(link.provider, link.model), floor: floor)
        walk_chain(rest, floor, call_fn, %{state | skipped: state.skipped ++ [skip], floor_skipped?: true})

      cooldown_active?(link) ->
        skip = skip_record(link, "credential_in_cooldown")
        walk_chain(rest, floor, call_fn, %{state | skipped: state.skipped ++ [skip]})

      true ->
        attempt_link(link, rest, floor, call_fn, state)
    end
  end

  defp attempt_link(link, rest, floor, call_fn, state) do
    case call_fn.(link) do
      {:ok, result} ->
        attempt = attempt_record(link, "succeeded", nil)
        {:ok, result, decision(%{state | attempts: state.attempts ++ [attempt]}, link, "fallback_succeeded")}

      {:error, failure} ->
        attempt = attempt_record(link, "failed", failure)
        state = record_failure(%{state | attempts: state.attempts ++ [attempt]}, failure)
        maybe_put_cooldown(link, failure)

        if retryable_failure?(failure) do
          walk_chain(rest, floor, call_fn, state)
        else
          {:error, {:non_retryable, failure}, decision(state, nil, "fallback_failed")}
        end
    end
  end

  defp chain(profile) do
    primary = %{
      "workspace_id" => Map.get(profile, "workspace_id"),
      "agent_id" => Map.get(profile, "agent_id"),
      "provider" => Map.get(profile, "provider"),
      "model" => Map.get(profile, "model"),
      "credential_ref" => Map.get(profile, "credential_ref")
    }

    [link_from(primary, :primary, 0) | fallback_links(profile)]
    |> Enum.reject(&is_nil/1)
  end

  defp fallback_links(profile) do
    profile
    |> Map.get("fallbacks", [])
    |> case do
      fallbacks when is_list(fallbacks) -> fallbacks
      _ -> []
    end
    |> Enum.with_index(1)
    |> Enum.map(fn {fallback, index} ->
      fallback
      |> normalize_keys()
      |> Map.put_new("workspace_id", Map.get(profile, "workspace_id"))
      |> Map.put_new("agent_id", Map.get(profile, "agent_id"))
      |> link_from(:fallback, index)
    end)
  end

  defp link_from(attrs, source, position) when is_map(attrs) do
    provider = normalize_string(Map.get(attrs, "provider"))

    if is_nil(provider) do
      nil
    else
      credential_ref = Map.get(attrs, "credential_ref")

      %CutoverLink{
        workspace_id: normalize_string(Map.get(attrs, "workspace_id")),
        agent_id: normalize_string(Map.get(attrs, "agent_id")),
        provider: provider,
        model: normalize_string(Map.get(attrs, "model")),
        credential_ref: credential_ref,
        credential_id: credential_id(credential_ref),
        position: position,
        source: source
      }
    end
  end

  defp below_floor?(link, floor) do
    link.provider
    |> ModelTiers.tier_of(link.model)
    |> ModelTiers.meets_floor?(floor)
    |> Kernel.not()
  end

  defp cooldown_active?(%CutoverLink{workspace_id: workspace_id, credential_id: credential_id})
       when is_binary(workspace_id) and is_binary(credential_id) do
    Cooldown.active?(workspace_id, credential_id)
  end

  defp cooldown_active?(_link), do: false

  defp maybe_put_cooldown(link, failure) do
    if rate_limited_failure?(failure) and is_binary(link.workspace_id) and is_binary(link.credential_id) do
      Cooldown.put(link.workspace_id, link.credential_id)
    end

    :ok
  end

  defp record_failure(%{first_failure: nil} = state, failure), do: %{state | first_failure: failure}
  defp record_failure(state, _failure), do: state

  defp decision(state, success_link, outcome) do
    first_attempt = List.first(state.attempts) || List.first(state.skipped) || %{}
    failure = state.first_failure || failure_from_attempt(first_attempt) || %{}

    %CutoverDecision{
      workspace_id: normalize_string(Map.get(state.context, "workspace_id") || Map.get(first_attempt, :workspace_id)),
      agent_id: normalize_string(Map.get(state.context, "agent_id") || Map.get(first_attempt, :agent_id)),
      work_item_id: normalize_string(Map.get(state.context, "work_item_id")),
      from_provider: Map.get(first_attempt, :provider),
      from_model: Map.get(first_attempt, :model),
      from_credential_id: Map.get(first_attempt, :credential_id),
      to_provider: success_link && success_link.provider,
      to_model: success_link && success_link.model,
      to_credential_id: success_link && success_link.credential_id,
      trigger_error_code: error_code(failure),
      trigger_status_code: status_code(failure),
      outcome: outcome,
      elapsed_ms: max(monotonic_ms() - state.started_at, 0),
      attempts: state.attempts,
      skipped: state.skipped
    }
  end

  defp attempt_record(link, outcome, failure) do
    link
    |> link_record()
    |> Map.put(:outcome, outcome)
    |> maybe_put(:error_code, error_code(failure))
    |> maybe_put(:status_code, status_code(failure))
    |> maybe_put(:retryable, retryable_failure?(failure))
    |> maybe_put(:failure, failure)
  end

  defp skip_record(link, reason, extra \\ []) do
    link
    |> link_record()
    |> Map.put(:outcome, "skipped")
    |> Map.put(:reason, reason)
    |> Map.merge(Map.new(extra))
  end

  defp link_record(%CutoverLink{} = link) do
    %{
      workspace_id: link.workspace_id,
      agent_id: link.agent_id,
      provider: link.provider,
      model: link.model,
      credential_id: link.credential_id,
      position: link.position,
      source: link.source
    }
  end

  defp failure_from_attempt(%{failure: failure}), do: failure
  defp failure_from_attempt(_attempt), do: nil

  defp retryable_failure?(failure) when is_map(failure) do
    Map.get(failure, :retryable) == true or Map.get(failure, "retryable") == true
  end

  defp retryable_failure?(_failure), do: false

  defp rate_limited_failure?(failure) do
    error_code(failure) == "provider_rate_limited" or status_code(failure) == 429
  end

  defp error_code(failure) when is_map(failure),
    do: normalize_string(Map.get(failure, :error_code) || Map.get(failure, "error_code"))

  defp error_code(_failure), do: nil

  defp status_code(failure) when is_map(failure),
    do: Map.get(failure, :status_code) || Map.get(failure, "status_code") || Map.get(failure, :status) || Map.get(failure, "status")

  defp status_code(_failure), do: nil

  defp credential_id(%{"type" => "credential_id", "value" => value}), do: normalize_string(value)
  defp credential_id(%{type: "credential_id", value: value}), do: normalize_string(value)
  defp credential_id(%{type: :credential_id, value: value}), do: normalize_string(value)
  defp credential_id(%{"credential_id" => value}), do: normalize_string(value)
  defp credential_id(%{credential_id: value}), do: normalize_string(value)
  defp credential_id(value) when is_binary(value), do: normalize_string(value)
  defp credential_id(_value), do: nil

  defp normalize_keys(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {canonical_key(Atom.to_string(key)), normalize_value(value)}
      {key, value} -> {canonical_key(key), normalize_value(value)}
    end)
  end

  defp normalize_keys(_value), do: %{}

  defp canonical_key("agentId"), do: "agent_id"
  defp canonical_key("workspaceId"), do: "workspace_id"
  defp canonical_key("runnerKind"), do: "runner_kind"
  defp canonical_key("credentialRef"), do: "credential_ref"
  defp canonical_key("modelTierFloor"), do: "model_tier_floor"
  defp canonical_key(key), do: key

  defp normalize_value(value) when is_map(value), do: normalize_keys(value)
  defp normalize_value(value) when is_list(value), do: Enum.map(value, &normalize_value/1)
  defp normalize_value(value), do: value

  defp normalize_string(value) when is_binary(value) do
    value = String.trim(value)
    if value == "", do: nil, else: value
  end

  defp normalize_string(value) when is_atom(value) and not is_nil(value),
    do: value |> Atom.to_string() |> normalize_string()

  defp normalize_string(_value), do: nil

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp monotonic_ms, do: System.monotonic_time(:millisecond)
end
