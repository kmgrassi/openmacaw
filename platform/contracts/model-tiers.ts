import { z } from "zod";

export const ModelTierSchema = z.enum(["local", "mid", "frontier"]);
export const ModelTierFloorSchema = z.enum(["any", "local", "mid", "frontier"]);

export type ModelTier = z.infer<typeof ModelTierSchema>;
export type ModelTierFloor = z.infer<typeof ModelTierFloorSchema>;

export type RegisteredModelTier = {
  provider: string;
  model: string;
  tier: ModelTier;
  label: string;
  executable: boolean;
};

export const MODEL_TIERS = [
  {
    provider: "openai",
    model: "openai/gpt-5.2",
    tier: "frontier",
    label: "GPT-5.2",
    executable: true,
  },
  {
    provider: "openai",
    model: "openai/gpt-5.1-codex",
    tier: "frontier",
    label: "GPT-5.1 Codex",
    executable: true,
  },
  {
    provider: "openai",
    model: "openai/gpt-4.1-mini",
    tier: "mid",
    label: "GPT-4.1 Mini",
    executable: true,
  },
  {
    provider: "openai_codex",
    model: "openai_codex/gpt-5.3-codex",
    tier: "frontier",
    label: "GPT-5.3 Codex",
    executable: true,
  },
  {
    provider: "anthropic",
    model: "anthropic/claude-opus-4-6",
    tier: "frontier",
    label: "Claude Opus 4.6",
    executable: true,
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    tier: "frontier",
    label: "Claude Opus 4.7",
    executable: true,
  },
  {
    provider: "anthropic",
    model: "anthropic/claude-sonnet-4-6",
    tier: "frontier",
    label: "Claude Sonnet 4.6",
    executable: true,
  },
  {
    provider: "anthropic",
    model: "anthropic/claude-haiku-4-5",
    tier: "mid",
    label: "Claude Haiku 4.5",
    executable: true,
  },
  {
    provider: "openai_compatible",
    model: "*",
    tier: "local",
    label: "OpenAI-compatible model",
    executable: true,
  },
  {
    provider: "local",
    model: "*",
    tier: "local",
    label: "Local relay model",
    executable: true,
  },
  {
    provider: "google",
    model: "google/gemini-2.5-pro",
    tier: "frontier",
    label: "Gemini 2.5 Pro",
    executable: false,
  },
  {
    provider: "mistral",
    model: "mistral/codestral-latest",
    tier: "mid",
    label: "Codestral",
    executable: false,
  },
] as const satisfies readonly RegisteredModelTier[];

export const MODEL_TIER_REGISTRY = MODEL_TIERS;

export type RegisteredProvider = (typeof MODEL_TIERS)[number]["provider"];

export function modelTier(
  provider: string | null | undefined,
  model: string | null | undefined,
): ModelTier | null {
  if (!provider || !model) return null;
  const exact = MODEL_TIERS.find(
    (entry) => entry.provider === provider && entry.model === model,
  );
  if (exact) return exact.tier;
  return (
    MODEL_TIERS.find(
      (entry) => entry.provider === provider && entry.model === "*",
    )?.tier ?? null
  );
}

export function modelRegistryEntry(
  provider: string | null | undefined,
  model: string | null | undefined,
): RegisteredModelTier | null {
  if (!provider || !model) return null;
  return (
    MODEL_TIERS.find(
      (entry) => entry.provider === provider && entry.model === model,
    ) ??
    MODEL_TIERS.find(
      (entry) => entry.provider === provider && entry.model === "*",
    ) ??
    null
  );
}
