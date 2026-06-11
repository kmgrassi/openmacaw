defmodule SymphonyElixir.Cutover do
  @moduledoc """
  Walks execution-profile fallback chains for cutover-eligible provider calls.

  Runner call sites supply the provider invocation as `call_fn`; this module
  owns chain ordering, model-tier floor enforcement, cooldown skipping, and the
  decision object returned to callers.
  """

  alias SymphonyElixir.Cutover.{Audit, Cooldown}
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
      :adapter_available?,
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
            adapter_available?: boolean(),
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
  @type classified_failure :: {:cutover_provider_failure, map(), term()}
  @type session_call_result :: {:ok, term()} | {:error, term()}
  @type session_call_fun :: (map(), non_neg_integer() -> session_call_result())

  @spec walk(profile(), map(), (CutoverLink.t() -> {:ok, term()} | {:error, term()}), keyword()) ::
          {:ok, term(), CutoverDecision.t()}
          | {:error, :exhausted | :floor_exhausted | {:non_retryable, term()}, CutoverDecision.t()}
  def walk(profile, context, call_fn, opts \\ []) when is_map(profile) and is_map(context) and is_function(call_fn, 1) do
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
    |> walk_chain(floor, call_fn, state, opts)
  end

  @spec walk_session(map(), atom() | String.t(), session_call_fun()) :: session_call_result()
  def walk_session(session, _runner_kind, call_fn) when is_map(session) and is_function(call_fn, 2) do
    session
    |> session_links()
    |> do_walk_session(call_fn, nil, 1)
  end

  @spec classified_failure(map(), term()) :: {:error, classified_failure()}
  def classified_failure(classification, reason) when is_map(classification) do
    {:error, {:cutover_provider_failure, classification, reason}}
  end

  defp do_walk_session([], _call_fn, nil, _attempt), do: {:error, {:fatal, :cutover_chain_empty}}
  defp do_walk_session([], _call_fn, last_error, _attempt), do: last_error

  defp do_walk_session([link | remaining], call_fn, _last_error, attempt) do
    case call_fn.(link, attempt) do
      {:ok, _result} = success ->
        success

      {:error, {:cutover_provider_failure, classification, reason}} = error ->
        if retryable_failure?(classification) and remaining != [] do
          do_walk_session(remaining, call_fn, {:error, reason}, attempt + 1)
        else
          unwrap_classified_error(error)
        end

      {:error, _reason} = error ->
        error
    end
  end

  defp session_links(session) do
    [session | fallback_sessions(session)]
  end

  defp fallback_sessions(session) do
    session
    |> session_fallback_links()
    |> List.wrap()
    |> Enum.filter(&is_map/1)
    |> Enum.map(&merge_session_link(session, &1))
  end

  defp session_fallback_links(session) do
    case session_value(session, :fallbacks, "fallbacks", []) do
      links when is_list(links) and links != [] ->
        links

      _empty ->
        session
        |> session_value(:execution_profile, "execution_profile", %{})
        |> session_normalize_map()
        |> session_value(:fallbacks, "fallbacks", [])
    end
  end

  defp merge_session_link(session, fallback) do
    adapter_config =
      fallback
      |> session_value(:adapter_config, "adapter_config", %{})
      |> session_normalize_map()
      |> normalize_adapter_config()

    session
    |> Map.merge(adapter_config)
    |> maybe_drop_provider_session_id(adapter_config, fallback)
    |> maybe_put_from_fallback(fallback, :provider, "provider")
    |> maybe_put_model_provider(fallback)
    |> maybe_put_from_fallback(fallback, :model, "model")
    |> maybe_put_from_fallback(fallback, :credential_id, "credential_id")
    |> maybe_put_from_fallback(fallback, :credential_scope, "credential_scope")
    |> maybe_put_from_fallback(fallback, :api_key, "api_key")
    |> maybe_put_from_fallback(fallback, :base_url, "base_url")
    |> maybe_put_from_fallback(fallback, :endpoint, "endpoint")
    |> maybe_put_from_fallback(fallback, :session_id, "session_id")
  end

  defp maybe_drop_provider_session_id(session, adapter_config, fallback) do
    if session_value(adapter_config, :session_id, "session_id", nil) ||
         session_value(fallback, :session_id, "session_id", nil) do
      session
    else
      Map.delete(session, :session_id)
    end
  end

  defp maybe_put_from_fallback(session, fallback, atom_key, string_key) do
    case session_value(fallback, atom_key, string_key, nil) do
      nil -> session
      value -> Map.put(session, atom_key, value)
    end
  end

  defp maybe_put_model_provider(session, fallback) do
    case session_value(fallback, :provider, "provider", nil) ||
           session_value(fallback, :model_provider, "model_provider", nil) do
      nil -> session
      value -> Map.put(session, :model_provider, value)
    end
  end

  defp unwrap_classified_error({:error, {:cutover_provider_failure, _classification, reason}}), do: {:error, reason}

  defp session_value(map, atom_key, string_key, default) do
    Map.get(map, atom_key) || Map.get(map, string_key) || default
  end

  defp session_normalize_map(value) when is_map(value), do: value
  defp session_normalize_map(_value), do: %{}

  defp normalize_adapter_config(config) do
    Enum.reduce([:api_key, :base_url, :endpoint, :model_provider, :session_id, :session_type], config, fn key, acc ->
      string_key = Atom.to_string(key)

      case Map.get(acc, string_key) do
        nil -> acc
        value -> Map.put(acc, key, value)
      end
    end)
  end

  defp walk_chain([], _floor, _call_fn, state, opts) do
    floor_only_exhaustion? = state.floor_skipped? and state.attempts == []
    outcome = if floor_only_exhaustion?, do: "escalated_floor", else: "escalated_exhausted"
    reason = if floor_only_exhaustion?, do: :floor_exhausted, else: :exhausted
    decision = decision(state, nil, outcome)
    audit(decision, opts)
    {:error, reason, decision}
  end

  defp walk_chain([link | rest], floor, call_fn, state, opts) do
    cond do
      not adapter_available?(link) ->
        skip = skip_record(link, "no_adapter")
        state = %{state | skipped: state.skipped ++ [skip]}
        audit(decision(state, link, "skipped_no_adapter"), opts)
        walk_chain(rest, floor, call_fn, state, opts)

      below_floor?(link, floor) ->
        skip = skip_record(link, "below_model_tier_floor", model_tier: ModelTiers.tier_of(link.provider, link.model), floor: floor)
        walk_chain(rest, floor, call_fn, %{state | skipped: state.skipped ++ [skip], floor_skipped?: true}, opts)

      cooldown_active?(link) ->
        skip = skip_record(link, "credential_in_cooldown")
        walk_chain(rest, floor, call_fn, %{state | skipped: state.skipped ++ [skip]}, opts)

      true ->
        attempt_link(link, rest, floor, call_fn, state, opts)
    end
  end

  defp attempt_link(link, rest, floor, call_fn, state, opts) do
    case call_fn.(link) do
      {:ok, result} ->
        attempt = attempt_record(link, "succeeded", nil)
        decision = decision(%{state | attempts: state.attempts ++ [attempt]}, link, "fallback_succeeded")
        audit(decision, opts)
        {:ok, result, decision}

      {:error, failure} ->
        attempt = attempt_record(link, "failed", failure)
        state = record_failure(%{state | attempts: state.attempts ++ [attempt]}, failure)
        maybe_put_cooldown(link, failure)

        if retryable_failure?(failure) do
          walk_chain(rest, floor, call_fn, state, opts)
        else
          decision = decision(state, nil, "fallback_failed")
          audit(decision, opts)
          {:error, {:non_retryable, failure}, decision}
        end
    end
  end

  defp audit(%CutoverDecision{} = decision, opts) do
    opts
    |> Keyword.get(:audit_module, Audit)
    |> apply(:write_best_effort, [decision, opts])
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
        adapter_available?: adapter_available?(attrs),
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

  defp adapter_available?(%CutoverLink{adapter_available?: value}), do: value != false
  defp adapter_available?(%{"adapter_available" => false}), do: false
  defp adapter_available?(%{"adapterAvailable" => false}), do: false
  defp adapter_available?(%{adapter_available?: false}), do: false
  defp adapter_available?(_attrs), do: true

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
