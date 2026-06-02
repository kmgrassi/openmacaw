import { ModelSettingsSchema, type ModelSettings } from "./agents.js";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function extractPrimaryModel(
  modelSettings: ModelSettings,
): string | null {
  const settings = ModelSettingsSchema.parse(modelSettings);
  return settings.primary ?? null;
}

export function deriveProviderFromModel(model: string | null): string | null {
  if (!model) return null;
  const [provider] = model.split("/", 1);
  return provider?.trim() || null;
}
