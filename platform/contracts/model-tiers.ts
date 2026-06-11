import { z } from "zod";

import { PROVIDER_REGISTRY } from "./provider-registry.js";

export const MODEL_TIERS = ["frontier", "mid", "local", "any"] as const;
export const ModelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = (typeof MODEL_TIERS)[number];
export type AssignableModelTier = Exclude<ModelTier, "any">;
export type RegisteredProvider = keyof typeof PROVIDER_REGISTRY;

export const RegisteredProviderSchema = z.enum(
  Object.keys(PROVIDER_REGISTRY) as [
    RegisteredProvider,
    ...RegisteredProvider[],
  ],
);

export const MODEL_TIER_REGISTRY: ReadonlyArray<{
  provider: RegisteredProvider;
  model: string;
  tier: AssignableModelTier;
}> = [
  { provider: "anthropic", model: "claude-opus-4-7", tier: "frontier" },
  { provider: "anthropic", model: "claude-sonnet-4-6", tier: "frontier" },
  { provider: "anthropic", model: "claude-haiku-4-5", tier: "mid" },

  { provider: "openai", model: "gpt-4.1", tier: "frontier" },
  { provider: "openai", model: "gpt-4.1-mini", tier: "mid" },
  { provider: "openai", model: "gpt-4o", tier: "frontier" },
  { provider: "openai", model: "gpt-4o-mini", tier: "mid" },
  { provider: "openai", model: "o3", tier: "frontier" },
  { provider: "openai", model: "o3-mini", tier: "mid" },
  { provider: "openai", model: "o1", tier: "frontier" },

  { provider: "openai_codex", model: "gpt-4o", tier: "frontier" },
  { provider: "openai_codex", model: "gpt-4.1", tier: "frontier" },
  { provider: "openai_codex", model: "o3", tier: "frontier" },

  { provider: "openai_compatible", model: "*", tier: "local" },
  {
    provider: "openai_compatible",
    model: "llama-3.1-405b-instruct",
    tier: "mid",
  },
  { provider: "openai_compatible", model: "qwen2.5-coder-32b", tier: "mid" },

  { provider: "google", model: "gemini-2.5-pro", tier: "frontier" },
  { provider: "google", model: "gemini-2.5-flash", tier: "mid" },
  { provider: "google", model: "gemini-2.0-flash", tier: "mid" },

  { provider: "xai", model: "grok-4", tier: "frontier" },
  { provider: "xai", model: "grok-3", tier: "frontier" },
  { provider: "xai", model: "grok-3-mini", tier: "mid" },

  { provider: "mistral", model: "mistral-large-2", tier: "frontier" },
  { provider: "mistral", model: "mistral-medium", tier: "mid" },
  { provider: "mistral", model: "codestral", tier: "mid" },

  { provider: "groq", model: "llama-3.3-70b-versatile", tier: "mid" },
  { provider: "groq", model: "llama-3.1-70b", tier: "mid" },
  { provider: "groq", model: "mixtral-8x7b", tier: "mid" },

  {
    provider: "openrouter",
    model: "anthropic/claude-opus-4-7",
    tier: "frontier",
  },
  {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-6",
    tier: "frontier",
  },
  { provider: "openrouter", model: "openai/gpt-4o", tier: "frontier" },
  {
    provider: "openrouter",
    model: "google/gemini-2.5-pro",
    tier: "frontier",
  },
  {
    provider: "openrouter",
    model: "meta-llama/llama-3.1-405b",
    tier: "frontier",
  },

  {
    provider: "together",
    model: "meta-llama/Llama-3.1-405B-Instruct",
    tier: "frontier",
  },
  {
    provider: "together",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    tier: "mid",
  },
  {
    provider: "together",
    model: "mistralai/Mixtral-8x22B-Instruct",
    tier: "mid",
  },

  { provider: "perplexity", model: "sonar-pro", tier: "mid" },
  { provider: "perplexity", model: "sonar", tier: "mid" },
  {
    provider: "perplexity",
    model: "llama-3.1-sonar-large-128k-online",
    tier: "mid",
  },

  { provider: "azure", model: "gpt-4o", tier: "frontier" },
  { provider: "azure", model: "gpt-4o-mini", tier: "mid" },
  { provider: "azure", model: "o3", tier: "frontier" },

  {
    provider: "bedrock",
    model: "anthropic.claude-opus-4-7-v1:0",
    tier: "frontier",
  },
  {
    provider: "bedrock",
    model: "anthropic.claude-sonnet-4-6-v1:0",
    tier: "frontier",
  },
  {
    provider: "bedrock",
    model: "meta.llama3-1-405b-instruct-v1:0",
    tier: "frontier",
  },
  {
    provider: "bedrock",
    model: "mistral.mistral-large-2407-v1:0",
    tier: "frontier",
  },
  { provider: "bedrock", model: "amazon.nova-pro-v1:0", tier: "mid" },
] as const;

export function modelTier(
  provider: RegisteredProvider,
  model: string,
): AssignableModelTier | null {
  const trimmedModel = model.trim();
  const exact = MODEL_TIER_REGISTRY.find(
    (entry) => entry.provider === provider && entry.model === trimmedModel,
  );
  if (exact) return exact.tier;

  const providerPrefix = `${provider}/`;
  if (trimmedModel.startsWith(providerPrefix)) {
    const unqualifiedModel = trimmedModel.slice(providerPrefix.length);
    const unqualified = MODEL_TIER_REGISTRY.find(
      (entry) =>
        entry.provider === provider && entry.model === unqualifiedModel,
    );
    if (unqualified) return unqualified.tier;
  }

  const wildcard = MODEL_TIER_REGISTRY.find(
    (entry) => entry.provider === provider && entry.model === "*",
  );
  return wildcard?.tier ?? null;
}
