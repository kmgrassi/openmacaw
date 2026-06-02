import { z } from "zod";

import { ModelProviderSchema } from "./provider-registry.js";
export { ModelProviderSchema } from "./provider-registry.js";
export const ModelAuthModeSchema = z.enum(["api_key", "oauth"]);
export const ModelInputTypeSchema = z.enum(["text", "image", "document"]);
export const ModelStatusSchema = z.enum(["active", "preview", "deprecated"]);
export const ModelCatalogSourceSchema = z.enum([
  "provider",
  "cache",
  "curated",
  "configured",
]);

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: ModelProviderSchema,
  providerName: z.string().min(1),
  source: ModelCatalogSourceSchema.default("curated"),
  authModes: z.array(ModelAuthModeSchema).min(1),
  status: ModelStatusSchema.default("active"),
  contextWindow: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(ModelInputTypeSchema).optional(),
  recommended: z.boolean().optional(),
  lastFetchedAt: z.string().optional(),
});

export const ModelCatalogErrorSchema = z.object({
  provider: ModelProviderSchema,
  code: z.string(),
  message: z.string(),
});

export const ModelProviderConnectionSchema = z.object({
  id: ModelProviderSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  authMode: ModelAuthModeSchema,
  credentialConfigured: z.boolean(),
  valid: z.boolean().nullable(),
  modelCount: z.number().int().nonnegative().optional(),
  lastValidatedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  requiresEndpoint: z.boolean().optional(),
});

export const ModelCatalogResponseSchema = z.object({
  models: z.array(ModelCatalogEntrySchema),
  fetchedAt: z.string(),
  errors: z.array(ModelCatalogErrorSchema).optional(),
});

export const ModelProviderListResponseSchema = z.object({
  providers: z.array(ModelProviderConnectionSchema),
  fetchedAt: z.string(),
});

export const SaveModelProviderCredentialRequestSchema = z.object({
  workspaceId: z.string().min(1),
  apiKey: z.string().min(1),
  endpoint: z.string().optional(),
  apiVersion: z.string().optional(),
});

export const SaveModelProviderCredentialResponseSchema = z.object({
  provider: ModelProviderConnectionSchema,
});

export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type ModelAuthMode = z.infer<typeof ModelAuthModeSchema>;
export type ModelInputType = z.infer<typeof ModelInputTypeSchema>;
export type ModelStatus = z.infer<typeof ModelStatusSchema>;
export type ModelCatalogSource = z.infer<typeof ModelCatalogSourceSchema>;
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;
export type ModelCatalogError = z.infer<typeof ModelCatalogErrorSchema>;
export type ModelProviderConnection = z.infer<
  typeof ModelProviderConnectionSchema
>;
export type ModelCatalogResponse = z.infer<typeof ModelCatalogResponseSchema>;
export type ModelProviderListResponse = z.infer<
  typeof ModelProviderListResponseSchema
>;
export type SaveModelProviderCredentialRequest = z.infer<
  typeof SaveModelProviderCredentialRequestSchema
>;
export type SaveModelProviderCredentialResponse = z.infer<
  typeof SaveModelProviderCredentialResponseSchema
>;
export const DEFAULT_MODEL_ID = "openai/gpt-5.2";

export const MODEL_CATALOG_FALLBACK: ModelCatalogEntry[] = [
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    provider: "openai",
    providerName: "OpenAI",
    source: "curated",
    authModes: ["api_key"],
    status: "active",
    reasoning: true,
    input: ["text", "image"],
    recommended: true,
  },
  {
    id: "openai/gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    provider: "openai",
    providerName: "OpenAI",
    source: "curated",
    authModes: ["api_key"],
    status: "active",
    reasoning: true,
    input: ["text", "image"],
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    provider: "openai",
    providerName: "OpenAI",
    source: "curated",
    authModes: ["api_key"],
    status: "active",
    input: ["text", "image"],
  },
  {
    id: "openai_codex/gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    provider: "openai_codex",
    providerName: "OpenAI Codex",
    source: "curated",
    authModes: ["oauth"],
    status: "active",
    reasoning: true,
    input: ["text"],
  },
  {
    id: "anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    providerName: "Anthropic",
    source: "curated",
    authModes: ["api_key"],
    status: "active",
    reasoning: true,
    input: ["text", "image", "document"],
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    providerName: "Anthropic",
    source: "curated",
    authModes: ["api_key"],
    status: "active",
    reasoning: true,
    input: ["text", "image", "document"],
  },
];

export const MODEL_CATALOG = MODEL_CATALOG_FALLBACK;

export function modelProviderFromId(
  modelId: string | null | undefined,
): string | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  const [provider] = trimmed.split("/", 1);
  return provider?.trim() || null;
}

/**
 * First catalog entry whose provider matches. Used by routing-rule sync
 * to pick a sensible model when the agent's current model is incompatible
 * with a newly-saved credential's provider (e.g., agent.model =
 * "qwen3-coder:30b" and the user just connected ChatGPT — we need a
 * default openai_codex model).
 */
export function defaultModelForProvider(
  provider: string | null | undefined,
): string | null {
  if (!provider) return null;
  const match = MODEL_CATALOG_FALLBACK.find(
    (entry) => entry.provider === provider,
  );
  return match?.id ?? null;
}

/**
 * True when `model` is already compatible with `provider` (its prefix
 * matches). Used to decide whether to keep the agent's existing model or
 * fall back to the provider default.
 */
export function modelMatchesProvider(
  model: string | null | undefined,
  provider: string | null | undefined,
): boolean {
  if (!model || !provider) return false;
  return modelProviderFromId(model) === provider;
}
