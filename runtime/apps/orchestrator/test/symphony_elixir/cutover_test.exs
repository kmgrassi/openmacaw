defmodule SymphonyElixir.CutoverTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Cutover
  alias SymphonyElixir.Cutover.Cooldown

  setup do
    if is_nil(Process.whereis(Cooldown)) do
      start_supervised!(Cooldown)
    end

    Cooldown.clear()
    :ok
  end

  test "model tier mirror classifies explicit and wildcard entries" do
    assert SymphonyElixir.ModelTiers.tier_of("anthropic", "claude-opus-4-7") == :frontier
    assert SymphonyElixir.ModelTiers.tier_of("openai_compatible", "qwen-2.5") == :local
    assert SymphonyElixir.ModelTiers.meets_floor?(nil, "local")
    refute SymphonyElixir.ModelTiers.meets_floor?(nil, "mid")
  end

  test "walk returns primary success without trying fallbacks" do
    profile = profile()

    assert {:ok, :primary_result, decision} =
             Cutover.walk(profile, context(), fn link ->
               assert link.source == :primary
               {:ok, :primary_result}
             end)

    assert decision.outcome == "fallback_succeeded"
    assert decision.to_provider == "openai"
    assert length(decision.attempts) == 1
  end

  test "walk skips links below the model tier floor" do
    profile =
      profile(%{
        "model_tier_floor" => "frontier",
        "fallbacks" => [
          %{"provider" => "openai", "model" => "gpt-4o-mini", "credential_ref" => credential("mid")},
          %{"provider" => "anthropic", "model" => "claude-opus-4-7", "credential_ref" => credential("frontier")}
        ]
      })

    assert {:ok, :frontier_result, decision} =
             Cutover.walk(profile, context(), fn
               %{source: :primary} -> retryable_failure("provider_overloaded")
               %{provider: "anthropic"} -> {:ok, :frontier_result}
             end)

    assert [%{reason: "below_model_tier_floor", provider: "openai"}] = decision.skipped
    assert decision.to_provider == "anthropic"
  end

  test "walk skips credentials in cooldown" do
    Cooldown.put("workspace-1", "fallback-1", ttl_ms: 60_000)

    profile =
      profile(%{
        "fallbacks" => [
          %{"provider" => "openai", "model" => "gpt-4o", "credential_ref" => credential("fallback-1")},
          %{"provider" => "anthropic", "model" => "claude-opus-4-7", "credential_ref" => credential("fallback-2")}
        ]
      })

    assert {:ok, :second_fallback_result, decision} =
             Cutover.walk(profile, context(), fn
               %{source: :primary} -> retryable_failure("provider_rate_limited", 429)
               %{credential_id: "fallback-2"} -> {:ok, :second_fallback_result}
             end)

    assert [%{reason: "credential_in_cooldown", credential_id: "fallback-1"}] = decision.skipped
    assert decision.to_credential_id == "fallback-2"
  end

  test "rate-limit failures place attempted credential in cooldown" do
    profile = profile(%{"credential_ref" => credential("primary-1"), "fallbacks" => []})

    assert {:error, :exhausted, decision} =
             Cutover.walk(profile, context(), fn _link ->
               retryable_failure("provider_rate_limited", 429)
             end)

    assert decision.outcome == "escalated_exhausted"
    assert Cooldown.active?("workspace-1", "primary-1")
  end

  test "walk exhausts retryable failures" do
    assert {:error, :exhausted, decision} =
             Cutover.walk(profile(), context(), fn _link ->
               retryable_failure("provider_overloaded")
             end)

    assert decision.outcome == "escalated_exhausted"
    assert decision.trigger_error_code == "provider_overloaded"
    assert length(decision.attempts) == 2
  end

  test "walk reports normal exhaustion when an eligible link failed before a floor skip" do
    profile =
      profile(%{
        "model_tier_floor" => "frontier",
        "provider" => "openai",
        "model" => "gpt-4o",
        "fallbacks" => [
          %{"provider" => "openai", "model" => "gpt-4o-mini", "credential_ref" => credential("mid")}
        ]
      })

    assert {:error, :exhausted, decision} =
             Cutover.walk(profile, context(), fn _link ->
               retryable_failure("provider_rate_limited", 429)
             end)

    assert decision.outcome == "escalated_exhausted"
    assert [%{reason: "below_model_tier_floor"}] = decision.skipped
    assert length(decision.attempts) == 1
  end

  test "walk reports floor exhaustion when no eligible link meets the floor" do
    profile =
      profile(%{
        "model_tier_floor" => "frontier",
        "provider" => "openai",
        "model" => "gpt-4o-mini",
        "fallbacks" => [
          %{"provider" => "openai_compatible", "model" => "qwen-2.5", "credential_ref" => credential("local")}
        ]
      })

    assert {:error, :floor_exhausted, decision} =
             Cutover.walk(profile, context(), fn _link ->
               flunk("below-floor links must not be called")
             end)

    assert decision.outcome == "escalated_floor"
    assert Enum.map(decision.skipped, & &1.reason) == ["below_model_tier_floor", "below_model_tier_floor"]
  end

  defp profile(overrides \\ %{}) do
    Map.merge(
      %{
        "workspace_id" => "workspace-1",
        "agent_id" => "agent-1",
        "runner_kind" => "manager",
        "provider" => "openai",
        "model" => "gpt-4o",
        "credential_ref" => credential("primary"),
        "fallbacks" => [
          %{"provider" => "anthropic", "model" => "claude-opus-4-7", "credential_ref" => credential("fallback")}
        ],
        "model_tier_floor" => "any"
      },
      overrides
    )
  end

  defp context do
    %{"workspace_id" => "workspace-1", "agent_id" => "agent-1", "work_item_id" => "work-item-1"}
  end

  defp credential(id), do: %{"type" => "credential_id", "value" => id}

  defp retryable_failure(error_code, status_code \\ nil) do
    {:error, %{error_code: error_code, status_code: status_code, retryable: true}}
  end
end
