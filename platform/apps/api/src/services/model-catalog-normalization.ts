import type {
  ModelAuthMode,
  ModelCatalogEntry,
  ModelCatalogSource,
  ModelInputType,
  ModelProvider,
} from "../../../../contracts/model-catalog.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function displayNameFromModelId(modelId: string) {
  return modelId
    .split("/")
    .pop()!
    .replace(/^models\//, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizedModelId(provider: ModelProvider, modelId: string) {
  const trimmed = modelId.trim().replace(/^models\//, "");
  return trimmed.startsWith(`${provider}/`) ? trimmed : `${provider}/${trimmed}`;
}

function inferInput(provider: ModelProvider, modelId: string): ModelInputType[] {
  const lower = modelId.toLowerCase();
  if (provider === "anthropic" || lower.includes("vision") || lower.includes("gpt-4") || lower.includes("gpt-5")) {
    return ["text", "image"];
  }
  return ["text"];
}

function inferReasoning(modelId: string) {
  return /\b(o\d|reasoning|gpt-5|claude|grok-4)\b/i.test(modelId);
}

export function makeModelEntry(input: {
  provider: ModelProvider;
  providerName: string;
  rawId: string;
  name?: string | null;
  authModes: ModelAuthMode[];
  source: ModelCatalogSource;
  lastFetchedAt: string;
  contextWindow?: number;
}): ModelCatalogEntry {
  const id = normalizedModelId(input.provider, input.rawId);
  return {
    id,
    name: input.name?.trim() || displayNameFromModelId(id),
    provider: input.provider,
    providerName: input.providerName,
    source: input.source,
    authModes: input.authModes,
    status: "active",
    contextWindow: input.contextWindow,
    reasoning: inferReasoning(id),
    input: inferInput(input.provider, id),
    lastFetchedAt: input.lastFetchedAt,
  };
}

export function arrayFromPayload(payload: unknown) {
  const record = asRecord(payload);
  const candidates = [record.data, record.models, payload];
  return candidates.find(Array.isArray) as unknown[] | undefined;
}

function extractId(item: unknown) {
  if (typeof item === "string") return item;
  const record = asRecord(item);
  return typeof record.id === "string"
    ? record.id
    : typeof record.name === "string"
      ? record.name
      : typeof record.model === "string"
        ? record.model
        : null;
}

export function extractModelOrId(item: unknown) {
  if (typeof item === "string") return item;
  const record = asRecord(item);
  return typeof record.model === "string" ? record.model : extractId(item);
}

export function extractDisplayName(item: unknown) {
  if (typeof item === "string") return null;
  const record = asRecord(item);
  return typeof record.display_name === "string"
    ? record.display_name
    : typeof record.displayName === "string"
      ? record.displayName
      : typeof record.name === "string" && !record.name.startsWith("models/")
        ? record.name
        : null;
}

export function extractContextWindow(item: unknown) {
  const record = asRecord(item);
  const candidates = [
    record.context_window,
    record.contextWindow,
    record.context_length,
    record.max_context_length,
    record.input_token_limit,
  ];
  const value = candidates.find((candidate) => typeof candidate === "number");
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function normalizePayloadModels(input: {
  payload: unknown;
  provider: ModelProvider;
  providerName: string;
  authModes: ModelAuthMode[];
  source: ModelCatalogSource;
  lastFetchedAt: string;
  include?: (id: string) => boolean;
}) {
  return (arrayFromPayload(input.payload) ?? [])
    .map((item) => {
      const rawId = extractId(item);
      if (!rawId || input.include?.(rawId) === false) return null;
      return makeModelEntry({
        provider: input.provider,
        providerName: input.providerName,
        rawId,
        name: extractDisplayName(item),
        authModes: input.authModes,
        source: input.source,
        lastFetchedAt: input.lastFetchedAt,
        contextWindow: extractContextWindow(item),
      });
    })
    .filter((model): model is ModelCatalogEntry => Boolean(model));
}
