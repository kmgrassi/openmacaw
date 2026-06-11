import { z } from "zod";

export const ProviderCutoverOutcomeSchema = z.enum([
  "fallback_succeeded",
  "fallback_failed",
  "escalated_floor",
  "escalated_exhausted",
  "skipped_no_adapter",
]);

export const ProviderCutoverSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  workItemId: z.string().uuid().nullable(),
  triggeredAt: z.string().datetime(),
  fromProvider: z.string().min(1),
  fromModel: z.string().min(1),
  fromCredentialId: z.string().uuid().nullable(),
  toProvider: z.string().min(1).nullable(),
  toModel: z.string().min(1).nullable(),
  toCredentialId: z.string().uuid().nullable(),
  triggerErrorCode: z.string().min(1),
  triggerStatusCode: z.number().int().nullable(),
  elapsedMs: z.number().int().nonnegative(),
  outcome: ProviderCutoverOutcomeSchema,
});

export const CreateProviderCutoverRequestSchema = ProviderCutoverSchema.pick({
  agentId: true,
  fromProvider: true,
  fromModel: true,
  fromCredentialId: true,
  toProvider: true,
  toModel: true,
  toCredentialId: true,
  triggerErrorCode: true,
  triggerStatusCode: true,
  elapsedMs: true,
  outcome: true,
}).extend({
  triggeredAt: z.string().datetime().optional(),
});

export const ProviderCutoverListResponseSchema = z.object({
  items: z.array(ProviderCutoverSchema),
});

export const ProviderCutoverRecentResponseSchema = z.object({
  items: z.array(ProviderCutoverSchema),
  nextCursor: z.string().min(1).nullable(),
});

export type ProviderCutoverOutcome = z.infer<
  typeof ProviderCutoverOutcomeSchema
>;
export type ProviderCutover = z.infer<typeof ProviderCutoverSchema>;
export type CreateProviderCutoverRequest = z.infer<
  typeof CreateProviderCutoverRequestSchema
>;
export type ProviderCutoverListResponse = z.infer<
  typeof ProviderCutoverListResponseSchema
>;
export type ProviderCutoverRecentResponse = z.infer<
  typeof ProviderCutoverRecentResponseSchema
>;
