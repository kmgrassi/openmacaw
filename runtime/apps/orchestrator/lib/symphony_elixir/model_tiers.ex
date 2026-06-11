defmodule SymphonyElixir.ModelTiers do
  @moduledoc """
  Runtime mirror of the platform model-tier registry.

  This file mirrors `contracts/model-tiers.ts` from the platform cutover
  contract. The registry assigns concrete provider/model pairs to execution
  adequacy tiers; `"any"` is only valid as a floor and is never returned as a
  model tier.
  """

  @type tier :: :frontier | :mid | :local
  @type floor :: tier() | :any

  @tier_order %{local: 0, mid: 1, frontier: 2}

  @registry %{
    {"anthropic", "claude-opus-4-7"} => :frontier,
    {"anthropic", "claude-sonnet-4-6"} => :frontier,
    {"anthropic", "claude-haiku-4-5"} => :mid,
    {"openai", "gpt-4.1"} => :frontier,
    {"openai", "gpt-4.1-mini"} => :mid,
    {"openai", "gpt-4o"} => :frontier,
    {"openai", "gpt-4o-mini"} => :mid,
    {"openai", "o3"} => :frontier,
    {"openai", "o3-mini"} => :mid,
    {"openai", "o1"} => :frontier,
    {"openai_codex", "gpt-4o"} => :frontier,
    {"openai_codex", "gpt-4.1"} => :frontier,
    {"openai_codex", "o3"} => :frontier,
    {"openai_compatible", "llama-3.1-405b-instruct"} => :mid,
    {"openai_compatible", "qwen2.5-coder-32b"} => :mid,
    {"google", "gemini-2.5-pro"} => :frontier,
    {"google", "gemini-2.5-flash"} => :mid,
    {"google", "gemini-2.0-flash"} => :mid,
    {"xai", "grok-4"} => :frontier,
    {"xai", "grok-3"} => :frontier,
    {"xai", "grok-3-mini"} => :mid,
    {"mistral", "mistral-large-2"} => :frontier,
    {"mistral", "mistral-medium"} => :mid,
    {"mistral", "codestral"} => :mid,
    {"groq", "llama-3.3-70b-versatile"} => :mid,
    {"groq", "llama-3.1-70b"} => :mid,
    {"groq", "mixtral-8x7b"} => :mid,
    {"openrouter", "anthropic/claude-opus-4-7"} => :frontier,
    {"openrouter", "anthropic/claude-sonnet-4-6"} => :frontier,
    {"openrouter", "openai/gpt-4o"} => :frontier,
    {"openrouter", "google/gemini-2.5-pro"} => :frontier,
    {"openrouter", "meta-llama/llama-3.1-405b"} => :frontier,
    {"together", "meta-llama/Llama-3.1-405B-Instruct"} => :frontier,
    {"together", "meta-llama/Llama-3.3-70B-Instruct"} => :mid,
    {"together", "mistralai/Mixtral-8x22B-Instruct"} => :mid,
    {"perplexity", "sonar-pro"} => :mid,
    {"perplexity", "sonar"} => :mid,
    {"perplexity", "llama-3.1-sonar-large-128k-online"} => :mid,
    {"azure", "gpt-4o"} => :frontier,
    {"azure", "gpt-4o-mini"} => :mid,
    {"azure", "o3"} => :frontier,
    {"bedrock", "anthropic.claude-opus-4-7-v1:0"} => :frontier,
    {"bedrock", "anthropic.claude-sonnet-4-6-v1:0"} => :frontier,
    {"bedrock", "meta.llama3-1-405b-instruct-v1:0"} => :frontier,
    {"bedrock", "mistral.mistral-large-2407-v1:0"} => :frontier,
    {"bedrock", "amazon.nova-pro-v1:0"} => :mid
  }

  @wildcards %{
    "openai_compatible" => :local
  }

  @spec tier_of(String.t() | atom() | nil, String.t() | atom() | nil) :: tier() | nil
  def tier_of(provider, model) do
    provider = normalize_string(provider)
    model = normalize_string(model)

    cond do
      is_nil(provider) or is_nil(model) ->
        nil

      tier = Map.get(@registry, {provider, model}) ->
        tier

      true ->
        Map.get(@wildcards, provider)
    end
  end

  @spec meets_floor?(tier() | nil, floor() | String.t() | atom() | nil) :: boolean()
  def meets_floor?(_tier, floor) when floor in [nil, "", :any, "any"], do: true

  def meets_floor?(nil, floor), do: meets_floor?(:local, floor)

  def meets_floor?(tier, floor) do
    with tier when tier in [:frontier, :mid, :local] <- normalize_tier(tier),
         floor when floor in [:frontier, :mid, :local] <- normalize_tier(floor) do
      Map.fetch!(@tier_order, tier) >= Map.fetch!(@tier_order, floor)
    else
      _ -> false
    end
  end

  @spec supported_floors() :: [String.t()]
  def supported_floors, do: ~w(any frontier mid local)

  defp normalize_tier(value) when value in [:frontier, :mid, :local, :any], do: value

  defp normalize_tier(value) when is_binary(value) do
    case normalize_string(value) do
      "frontier" -> :frontier
      "mid" -> :mid
      "local" -> :local
      "any" -> :any
      _ -> nil
    end
  end

  defp normalize_tier(_value), do: nil

  defp normalize_string(value) when is_binary(value) do
    value = String.trim(value)
    if value == "", do: nil, else: value
  end

  defp normalize_string(value) when is_atom(value) and not is_nil(value),
    do: value |> Atom.to_string() |> normalize_string()

  defp normalize_string(_value), do: nil
end
