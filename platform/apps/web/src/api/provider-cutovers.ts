import { z } from "zod";

import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export const providerCutoverOutcomeSchema = z.enum([
  "fallback_succeeded",
  "fallback_failed",
  "escalated_floor",
  "escalated_exhausted",
  "skipped_no_adapter",
]);

export const providerCutoverSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  workItemId: z.string().nullable().optional().default(null),
  triggeredAt: z.string(),
  fromProvider: z.string(),
  fromModel: z.string(),
  fromCredentialId: z.string().nullable().optional().default(null),
  toProvider: z.string().nullable().optional().default(null),
  toModel: z.string().nullable().optional().default(null),
  toCredentialId: z.string().nullable().optional().default(null),
  triggerErrorCode: z.string(),
  triggerStatusCode: z.number().nullable().optional().default(null),
  elapsedMs: z.number(),
  outcome: providerCutoverOutcomeSchema,
});

const workItemCutoversResponseSchema = z.object({
  cutovers: z.array(providerCutoverSchema),
});

const workspaceRecentCutoversResponseSchema = z.object({
  items: z.array(providerCutoverSchema),
  nextCursor: z.string().nullable().optional().default(null),
});

export type ProviderCutoverOutcome = z.infer<
  typeof providerCutoverOutcomeSchema
>;
export type ProviderCutover = z.infer<typeof providerCutoverSchema>;
export type WorkItemCutoversResponse = z.infer<
  typeof workItemCutoversResponseSchema
>;
export type WorkspaceRecentCutoversResponse = z.infer<
  typeof workspaceRecentCutoversResponseSchema
>;

export function listWorkItemCutovers(
  workItemId: string,
): Promise<WorkItemCutoversResponse> {
  return apiFetch(ROUTES.workItemCutovers(workItemId), {
    schema: workItemCutoversResponseSchema,
    defaultErrorMessage: "Could not load provider cutover audit details.",
  });
}

export function listWorkspaceRecentCutovers(
  workspaceId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<WorkspaceRecentCutoversResponse> {
  return apiFetch(ROUTES.workspaceRecentCutovers(workspaceId, options), {
    schema: workspaceRecentCutoversResponseSchema,
    defaultErrorMessage: "Could not load recent provider cutovers.",
  });
}
