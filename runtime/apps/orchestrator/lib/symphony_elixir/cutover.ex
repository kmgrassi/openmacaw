defmodule SymphonyElixir.Cutover do
  @moduledoc """
  Walks an execution profile's provider fallback chain and emits audit rows.

  This module owns the decision shape used by runner integrations. It accepts
  both generated execution-profile structs and plain maps so it can be wired
  before the generated profile mirror grows explicit fallback fields.
  """

  alias SymphonyElixir.Cutover.{Audit, Decision, Link}

  @type walk_result ::
          {:ok, term(), Decision.t()}
          | {:error, :exhausted | :floor_exhausted | :no_adapter, Decision.t()}
          | {:error, term()}

  @spec walk(map() | struct(), map(), (Link.t() -> {:ok, term()} | {:error, term()}), keyword()) ::
          walk_result()
  def walk(profile, context, call_fn, opts \\ [])
      when is_map(context) and is_function(call_fn, 1) do
    started_at = monotonic_ms()
    primary = primary_link(profile)

    profile
    |> chain(primary)
    |> Enum.reduce_while({:continue, []}, fn link, {:continue, attempts} ->
      cond do
        not adapter_available?(link) ->
          decision =
            decision(profile, context, primary, link, attempts, %{
              outcome: :skipped_no_adapter,
              error_code: "provider_adapter_missing",
              elapsed_ms: elapsed_ms(started_at)
            })

          audit(decision, opts)
          {:halt, {:error, :no_adapter, decision}}

        true ->
          case call_fn.(link) do
            {:ok, result} ->
              decision =
                decision(profile, context, primary, link, attempts, %{
                  outcome: :fallback_succeeded,
                  error_code: trigger_error_code(attempts),
                  status_code: trigger_status_code(attempts),
                  elapsed_ms: elapsed_ms(started_at)
                })

              audit(decision, opts)
              {:halt, {:ok, result, decision}}

            {:error, failure} ->
              attempt = attempt_for(link, failure)

              if retryable?(failure) do
                {:cont, {:continue, attempts ++ [attempt]}}
              else
                {:halt, {:error, failure}}
              end
          end
      end
    end)
    |> exhausted_decision(profile, context, primary, started_at, opts)
  end

  defp exhausted_decision({:continue, attempts}, profile, context, primary, started_at, opts) do
    outcome = if floor_exhausted?(attempts), do: :escalated_floor, else: :escalated_exhausted
    reason = if outcome == :escalated_floor, do: :floor_exhausted, else: :exhausted

    decision =
      decision(profile, context, primary, List.last(attempts), attempts, %{
        outcome: outcome,
        error_code: trigger_error_code(attempts),
        status_code: trigger_status_code(attempts),
        elapsed_ms: elapsed_ms(started_at)
      })

    audit(decision, opts)
    {:error, reason, decision}
  end

  defp exhausted_decision(result, _profile, _context, _primary, _started_at, _opts), do: result

  defp audit(%Decision{} = decision, opts) do
    opts
    |> Keyword.get(:audit_module, Audit)
    |> apply(:write_best_effort, [decision, opts])
  end

  defp decision(profile, context, primary, target, attempts, attrs) do
    target = target_link(target)

    %Decision{
      workspace_id: required_context(context, profile, ["workspace_id", "workspaceId", :workspace_id]),
      agent_id: required_context(context, profile, ["agent_id", "agentId", :agent_id]),
      work_item_id: context_value(context, ["work_item_id", "workItemId", :work_item_id]),
      from_provider: primary.provider,
      from_model: primary.model,
      from_credential_id: primary.credential_id,
      to_provider: target && target.provider,
      to_model: target && target.model,
      to_credential_id: target && target.credential_id,
      trigger_error_code: Map.get(attrs, :error_code) || "provider_unknown",
      trigger_status_code: Map.get(attrs, :status_code),
      elapsed_ms: Map.fetch!(attrs, :elapsed_ms),
      outcome: Map.fetch!(attrs, :outcome),
      triggered_at: DateTime.utc_now(),
      attempts: attempts
    }
  end

  defp primary_link(profile) do
    %Link{
      provider: profile_value(profile, ["provider", :provider]),
      model: profile_value(profile, ["model", :model]),
      credential_ref: profile_value(profile, ["credential_ref", "credentialRef", :credential_ref]),
      credential_id: credential_id(profile_value(profile, ["credential_ref", "credentialRef", :credential_ref])),
      runner_kind: profile_value(profile, ["runner_kind", "runnerKind", :runner_kind]),
      position: 0
    }
  end

  defp chain(profile, primary) do
    fallbacks =
      profile
      |> profile_value(["fallbacks", :fallbacks])
      |> case do
        links when is_list(links) -> links
        _ -> []
      end
      |> Enum.with_index(1)
      |> Enum.map(fn {link, position} -> normalize_link(link, position) end)

    [primary | fallbacks]
  end

  defp normalize_link(%Link{} = link, position), do: %{link | position: link.position || position}

  defp normalize_link(link, position) when is_map(link) do
    credential_ref = map_value(link, ["credential_ref", "credentialRef", :credential_ref])

    %Link{
      provider: map_value(link, ["provider", :provider]),
      model: map_value(link, ["model", :model]),
      credential_ref: credential_ref,
      credential_id: map_value(link, ["credential_id", "credentialId", :credential_id]) || credential_id(credential_ref),
      runner_kind: map_value(link, ["runner_kind", "runnerKind", :runner_kind]),
      position: map_value(link, ["position", :position]) || position,
      adapter_available?: adapter_available?(link),
      metadata: map_value(link, ["metadata", :metadata]) || %{}
    }
  end

  defp normalize_link(_link, position), do: %Link{position: position, adapter_available?: false}

  defp target_link(%Link{} = link), do: link
  defp target_link(%{} = attempt), do: Map.get(attempt, :link) || Map.get(attempt, "link")
  defp target_link(_target), do: nil

  defp attempt_for(%Link{} = link, failure) do
    %{
      link: link,
      error_code: failure_value(failure, ["error_code", :error_code]) || "provider_unknown",
      status_code: failure_value(failure, ["status_code", :status_code, "status", :status, "provider_status", :provider_status]),
      retryable: retryable?(failure),
      floor_exhausted?: failure_value(failure, ["floor_exhausted?", :floor_exhausted?]) == true
    }
  end

  defp trigger_error_code([]), do: "provider_unknown"
  defp trigger_error_code([attempt | _attempts]), do: Map.get(attempt, :error_code)

  defp trigger_status_code([]), do: nil
  defp trigger_status_code([attempt | _attempts]), do: Map.get(attempt, :status_code)

  defp retryable?(%{retryable: true}), do: true
  defp retryable?(%{"retryable" => true}), do: true
  defp retryable?(_failure), do: false

  defp floor_exhausted?(attempts), do: Enum.any?(attempts, &Map.get(&1, :floor_exhausted?))

  defp adapter_available?(%Link{adapter_available?: value}), do: value != false
  defp adapter_available?(%{adapter_available?: false}), do: false
  defp adapter_available?(%{"adapterAvailable" => false}), do: false
  defp adapter_available?(%{"adapter_available" => false}), do: false
  defp adapter_available?(_link), do: true

  defp credential_id(%{"id" => value}) when is_binary(value), do: value
  defp credential_id(%{id: value}) when is_binary(value), do: value
  defp credential_id(%{"credential_id" => value}) when is_binary(value), do: value
  defp credential_id(%{credential_id: value}) when is_binary(value), do: value
  defp credential_id(value) when is_binary(value), do: value
  defp credential_id(_value), do: nil

  defp required_context(context, profile, keys) do
    context_value(context, keys) || profile_value(profile, keys) || raise ArgumentError, "missing cutover audit context"
  end

  defp context_value(context, keys), do: map_value(context, keys)

  defp profile_value(%_{} = profile, keys), do: profile |> Map.from_struct() |> map_value(keys)
  defp profile_value(profile, keys), do: map_value(profile, keys)

  defp map_value(map, keys) when is_map(map) do
    Enum.find_value(keys, &Map.get(map, &1))
  end

  defp failure_value(%{} = failure, keys), do: map_value(failure, keys)
  defp failure_value(_failure, _keys), do: nil

  defp monotonic_ms, do: System.monotonic_time(:millisecond)
  defp elapsed_ms(started_at), do: max(monotonic_ms() - started_at, 0)
end
