import { z } from "zod";

import { PROVIDER_REGISTRY } from "./provider-registry.js";

export const MODEL_TIERS = ["frontier", "mid", "local", "any"] as const;
export const ModelTierSchema = z.enum(MODEL_TIERS);
export const ModelTierFloorSchema = z.enum(["any", "local", "mid", "frontier"]);

export type ModelTier = (typeof MODEL_TIERS)[number];
export type ModelTierFloor = z.infer<typeof ModelTierFloorSchema>;
export type AssignableModelTier = Exclude<ModelTier, "any">;
export type RegisteredProvider = keyof typeof PROVIDER_REGISTRY;

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

export type ModelTierRegistryEntry = (typeof MODEL_TIER_REGISTRY)[number];

export type RegisteredModelTier = ModelTierRegistryEntry & {
  label: string;
  executable: boolean;
};

export function modelTier(
  provider: string | null | undefined,
  model: string | null | undefined,
): AssignableModelTier | null {
  if (!provider || !model) return null;
  const exact = MODEL_TIER_REGISTRY.find(
    (entry) => entry.provider === provider && entry.model === model,
  );
  if (exact) return exact.tier;

  const wildcard = MODEL_TIER_REGISTRY.find(
    (entry) => entry.provider === provider && entry.model === "*",
  );
  return wildcard?.tier ?? null;
}

export function modelRegistryEntry(
  provider: string | null | undefined,
  model: string | null | undefined,
): RegisteredModelTier | null {
  if (!provider || !model) return null;
  const entry =
    MODEL_TIER_REGISTRY.find(
      (candidate) =>
        candidate.provider === provider && candidate.model === model,
    ) ??
    MODEL_TIER_REGISTRY.find(
      (candidate) => candidate.provider === provider && candidate.model === "*",
    );

  return entry
    ? {
        ...entry,
        label: modelTierLabel(entry.model),
        executable: modelTierEntryExecutable(entry.provider),
      }
    : null;
}

export function modelTierLabel(model: string): string {
  if (model === "*") return "Any model";
  return model
    .split(/[/:._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function modelTierEntryExecutable(provider: string): boolean {
  return ["anthropic", "openai", "openai_codex", "openai_compatible"].includes(
    provider,
  );
}
