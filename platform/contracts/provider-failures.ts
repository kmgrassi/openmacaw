import { z } from "zod";

import { RunnerKindSchema } from "./execution-profile.js";

export const ProviderFailureErrorCodeSchema = z.enum([
  "provider_auth_failed",
  "provider_content_refused",
  "provider_invalid_request",
  "provider_overloaded",
  "provider_rate_limited",
  "provider_stream_interrupted",
  "provider_timeout",
  "provider_unknown",
]);

export const ProviderFailureRunnerKindSchema = z.union([
  RunnerKindSchema,
  z.literal("manager"),
]);

export const ProviderFailureProviderSchema = z.enum([
  "openai",
  "anthropic",
  "openai_compatible",
  "openai_codex",
  "xai",
  "google",
  "mistral",
  "groq",
  "openrouter",
  "together",
  "perplexity",
  "azure",
  "codex",
  "openclaw",
  "computer_use",
  "local",
]);

export const ProviderFailureSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  workspaceId: z.string(),
  agentId: z.string().nullable(),
  workItemId: z.string().nullable(),
  runId: z.string().nullable(),
  runnerKind: ProviderFailureRunnerKindSchema,
  provider: ProviderFailureProviderSchema,
  model: z.string(),
  errorCode: ProviderFailureErrorCodeSchema,
  statusCode: z.number().int().nullable(),
  attempt: z.number().int().positive(),
});

export const ProviderFailureRecentResponseSchema = z.object({
  items: z.array(ProviderFailureSchema),
  nextCursor: z.string().nullable(),
});

export const ProviderFailureSummaryEntrySchema = z.object({
  provider: ProviderFailureProviderSchema,
  model: z.string(),
  errorCode: ProviderFailureErrorCodeSchema,
  count: z.number().int().nonnegative(),
});

export const ProviderFailureSummaryResponseSchema = z.object({
  since: z.string(),
  items: z.array(ProviderFailureSummaryEntrySchema),
});

export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;
export type ProviderFailureErrorCode = z.infer<
  typeof ProviderFailureErrorCodeSchema
>;
export type ProviderFailureRecentResponse = z.infer<
  typeof ProviderFailureRecentResponseSchema
>;
export type ProviderFailureSummaryEntry = z.infer<
  typeof ProviderFailureSummaryEntrySchema
>;
export type ProviderFailureSummaryResponse = z.infer<
  typeof ProviderFailureSummaryResponseSchema
>;
