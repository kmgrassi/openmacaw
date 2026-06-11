defmodule SymphonyElixir.Cutover do
  @moduledoc """
  Walks an execution profile's provider fallback chain.

  Runners provide the per-link provider call; this module owns the shared
  decision semantics for retryable provider failures, adequacy floors, and
  temporary credential cooldowns.
  """

  alias SymphonyElixir.Cutover.Cooldown
  alias SymphonyElixir.ModelTiers

  defmodule Link do
    @moduledoc """
    One executable provider/model/credential candidate in a cutover chain.
    """

    @enforce_keys [:provider, :model]
    defstruct [
      :provider,
      :model,
      :credential_id,
      :credential_ref,
      :api_key,
      :base_url,
      :model_client,
      :position,
      :attempt
    ]

    @type t :: %__MODULE__{
            provider: String.t(),
            model: String.t(),
            credential_id: String.t() | nil,
            credential_ref: map() | String.t() | nil,
            api_key: String.t() | nil,
            base_url: String.t() | nil,
            model_client: module() | nil,
            position: non_neg_integer() | nil,
            attempt: pos_integer() | nil
          }
  end

  defmodule Decision do
    @moduledoc """
    Summary of one cutover walk.
    """

    defstruct [
      :workspace_id,
      :agent_id,
      :work_item_id,
      :run_id,
      :trace_id,
      :model_tier_floor,
      :trigger_error_code,
      :selected_provider,
      :selected_model,
      :outcome,
      attempts: []
    ]

    @type t :: %__MODULE__{
            workspace_id: String.t() | nil,
            agent_id: String.t() | nil,
            work_item_id: String.t() | nil,
            run_id: String.t() | nil,
            trace_id: String.t() | nil,
            model_tier_floor: String.t(),
            trigger_error_code: String.t() | nil,
            selected_provider: String.t() | nil,
            selected_model: String.t() | nil,
            outcome: atom() | nil,
            attempts: [map()]
          }
  end

  @type failure :: map()
  @type walk_result ::
          {:ok, term(), Decision.t()}
          | {:error, :exhausted | :floor_exhausted, Decision.t()}
          | {:error, {:fatal, term()}, Decision.t()}

  @spec walk(map(), map(), (Link.t() -> {:ok, term()} | {:error, term()})) :: walk_result()
  def walk(profile, context, call_fn) when is_map(profile) and is_map(context) and is_function(call_fn, 1) do
    floor = model_tier_floor(profile)
    decision = base_decision(profile, context, floor)

    profile
    |> chain()
    |> Enum.with_index(1)
    |> do_walk(floor, context, call_fn, decision)
  end

  defp do_walk([], _floor, _context, _call_fn, %Decision{attempts: attempts} = decision) do
    reason = if Enum.any?(attempts, &(Map.get(&1, :skipped_reason) == :below_floor)), do: :floor_exhausted, else: :exhausted
    {:error, reason, %{decision | outcome: reason}}
  end

  defp do_walk([{link, attempt} | rest], floor, context, call_fn, decision) do
    link = %{link | attempt: attempt}

    cond do
      below_floor?(link, floor) ->
        do_walk(rest, floor, context, call_fn, append_attempt(decision, link, :skipped, :below_floor, nil))

      Cooldown.active?(workspace_id(context, decision), link.credential_id) ->
        do_walk(rest, floor, context, call_fn, append_attempt(decision, link, :skipped, :cooldown, nil))

      true ->
        case call_fn.(link) do
          {:ok, result} ->
            {:ok, result,
             decision
             |> append_attempt(link, :succeeded, nil, nil)
             |> Map.merge(%{
               selected_provider: link.provider,
               selected_model: link.model,
               outcome: :fallback_succeeded
             })}

          {:error, reason} ->
            handle_failure(reason, link, rest, floor, context, call_fn, decision)
        end
    end
  end

  defp handle_failure(reason, link, rest, floor, context, call_fn, decision) do
    failure = provider_failure(reason)
    decision = append_attempt(decision, link, :failed, nil, failure)
    decision = %{decision | trigger_error_code: decision.trigger_error_code || Map.get(failure, :error_code)}

    cond do
      retryable?(failure) ->
        maybe_cooldown(link, context, decision, failure)
        do_walk(rest, floor, context, call_fn, decision)

      true ->
        {:error, {:fatal, reason}, %{decision | outcome: :fatal_provider_failure}}
    end
  end

  defp chain(profile) do
    primary = %{
      "provider" => value(profile, "provider"),
      "model" => value(profile, "model"),
      "credential_id" => value(profile, "credential_id"),
      "credential_ref" => value(profile, "credential_ref"),
      "api_key" => value(profile, "api_key"),
      "base_url" => value(profile, "base_url"),
      "model_client" => value(profile, "model_client")
    }

    [primary | List.wrap(value(profile, "fallbacks"))]
    |> Enum.reject(&blank_link?/1)
    |> Enum.with_index()
    |> Enum.map(fn {link, position} -> to_link(link, position) end)
  end

  defp blank_link?(link), do: blank?(value(link, "provider")) or blank?(value(link, "model"))

  defp to_link(link, position) do
    %Link{
      provider: to_string(value(link, "provider")),
      model: to_string(value(link, "model")),
      credential_id: value(link, "credential_id") || credential_ref_value(value(link, "credential_ref")),
      credential_ref: value(link, "credential_ref"),
      api_key: value(link, "api_key"),
      base_url: value(link, "base_url"),
      model_client: value(link, "model_client"),
      position: position
    }
  end

  defp below_floor?(_link, "any"), do: false

  defp below_floor?(%Link{} = link, floor) do
    case ModelTiers.tier_of(link.provider, link.model) do
      {:ok, tier} -> ModelTiers.compare(tier, floor) == :lt
      :error -> true
    end
  end

  defp append_attempt(%Decision{attempts: attempts} = decision, %Link{} = link, status, skipped_reason, failure) do
    attempt =
      %{
        provider: link.provider,
        model: link.model,
        credential_id: link.credential_id,
        position: link.position,
        attempt: link.attempt,
        status: status,
        skipped_reason: skipped_reason,
        error_code: Map.get(failure || %{}, :error_code)
      }
      |> Enum.reject(fn {_key, value} -> is_nil(value) end)
      |> Map.new()

    %{decision | attempts: attempts ++ [attempt]}
  end

  defp provider_failure({:retryable, failure}), do: provider_failure(failure) |> Map.put(:retryable, true)
  defp provider_failure({:fatal, failure}), do: provider_failure(failure) |> Map.put(:retryable, false)

  defp provider_failure(failure) when is_map(failure) do
    %{
      error_code: value(failure, "error_code"),
      retryable: value(failure, "retryable") == true
    }
  end

  defp provider_failure(reason), do: %{error_code: inspect(reason), retryable: false}

  defp retryable?(%{retryable: true}), do: true
  defp retryable?(_failure), do: false

  defp maybe_cooldown(%Link{credential_id: nil}, _context, _decision, _failure), do: :ok

  defp maybe_cooldown(%Link{} = link, context, decision, %{error_code: "provider_rate_limited"}) do
    Cooldown.put(workspace_id(context, decision), link.credential_id)
  end

  defp maybe_cooldown(_link, _context, _decision, _failure), do: :ok

  defp base_decision(profile, context, floor) do
    %Decision{
      workspace_id: value(context, "workspace_id") || value(profile, "workspace_id"),
      agent_id: value(context, "agent_id") || value(profile, "agent_id"),
      work_item_id: value(context, "work_item_id") || value(profile, "work_item_id"),
      run_id: value(context, "run_id") || value(profile, "run_id"),
      trace_id: value(context, "trace_id") || value(profile, "trace_id"),
      model_tier_floor: floor
    }
  end

  defp workspace_id(context, decision), do: value(context, "workspace_id") || decision.workspace_id

  defp model_tier_floor(profile) do
    case value(profile, "model_tier_floor") || value(profile, "modelTierFloor") do
      floor when floor in ["frontier", "mid", "local"] -> floor
      _ -> "any"
    end
  end

  defp credential_ref_value(%{"value" => value}), do: value
  defp credential_ref_value(%{value: value}), do: value
  defp credential_ref_value(value) when is_binary(value), do: value
  defp credential_ref_value(_value), do: nil

  defp value(map, key) when is_map(map) and is_binary(key), do: Map.get(map, key) || Map.get(map, String.to_atom(key))
  defp value(_map, _key), do: nil

  defp blank?(value), do: is_nil(value) or value == ""
end
