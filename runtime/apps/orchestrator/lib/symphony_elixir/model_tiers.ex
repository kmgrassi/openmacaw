defmodule SymphonyElixir.ModelTiers do
  @moduledoc """
  Runtime mirror of the platform model-tier registry.
  """

  @tiers %{
    {"anthropic", "claude-opus-4-7"} => "frontier",
    {"anthropic", "claude-sonnet-4-6"} => "frontier",
    {"anthropic", "claude-haiku-4-5"} => "mid",
    {"openai", "gpt-5.1"} => "frontier",
    {"openai", "gpt-4.1"} => "frontier",
    {"openai", "gpt-4.1-mini"} => "mid",
    {"openai", "gpt-4o"} => "frontier",
    {"openai", "gpt-4o-mini"} => "mid",
    {"openai", "o3"} => "frontier",
    {"openai", "o3-mini"} => "mid",
    {"openai", "o1"} => "frontier",
    {"openai_codex", "gpt-4o"} => "frontier",
    {"openai_codex", "gpt-4.1"} => "frontier",
    {"openai_codex", "o3"} => "frontier",
    {"openai_compatible", "*"} => "local",
    {"openai_compatible", "llama-3.1-405b-instruct"} => "mid",
    {"openai_compatible", "qwen2.5-coder-32b"} => "mid"
  }

  @rank %{"local" => 0, "mid" => 1, "frontier" => 2}

  @spec tier_of(String.t(), String.t()) :: {:ok, String.t()} | :error
  def tier_of(provider, model) when is_binary(provider) and is_binary(model) do
    case Map.get(@tiers, {provider, model}) || Map.get(@tiers, {provider, "*"}) do
      nil -> :error
      tier -> {:ok, tier}
    end
  end

  def tier_of(_provider, _model), do: :error

  @spec compare(String.t(), String.t()) :: :lt | :eq | :gt
  def compare(tier, floor) do
    tier_rank = Map.fetch!(@rank, tier)
    floor_rank = Map.fetch!(@rank, floor)

    cond do
      tier_rank < floor_rank -> :lt
      tier_rank > floor_rank -> :gt
      true -> :eq
    end
  end
end
