import { z } from "zod";

import type { WorkItemProjection, WorkItemSnoozeActor } from "./plans";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

const snoozeActorSchema: z.ZodType<WorkItemSnoozeActor> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("user"), userId: z.string() }),
    z.object({ kind: z.literal("agent"), agentId: z.string() }),
  ],
);

const workItemProjectionSchema: z.ZodType<WorkItemProjection> = z.object({
  id: z.string(),
  taskId: z.string().nullable().optional().default(null),
  workspaceId: z.string().nullable().optional().default(null),
  planId: z.string().nullable().optional().default(null),
  identifier: z.string().nullable().optional().default(null),
  title: z.string().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  instructions: z.string().nullable().optional().default(null),
  state: z.string().nullable().optional().default(null),
  priority: z.string().nullable().optional().default(null),
  source: z.string().nullable().optional().default(null),
  runnerKind: z.string().nullable().optional().default(null),
  repository: z.string().nullable().optional().default(null),
  labels: z.array(z.string()).nullable().optional().default(null),
  dependsOn: z.array(z.string()).optional().default([]),
  completionGates: z.array(z.string()).optional().default([]),
  metadata: z.unknown(),
  nextPollAt: z.string().nullable().optional().default(null),
  lastPolledAt: z.string().nullable().optional().default(null),
  pollCadenceSeconds: z.number().nullable().optional().default(null),
  snooze: z
    .object({
      indefinite: z.boolean(),
      reason: z.string().nullable().optional().default(null),
      snoozedAt: z.string(),
      snoozedBy: snoozeActorSchema,
    })
    .nullable()
    .optional()
    .default(null),
  createdAt: z.string().nullable().optional().default(null),
  updatedAt: z.string().nullable().optional().default(null),
});

const workItemMutationResponseSchema = z.object({
  workItem: workItemProjectionSchema,
});

export type SnoozeWorkItemInput =
  | { seconds: number; reason?: string }
  | { until: string; reason?: string }
  | { indefinite: true; reason?: string };

export type WorkItemMutationResponse = z.infer<
  typeof workItemMutationResponseSchema
>;

export function snoozeWorkItem(
  workspaceId: string,
  workItemId: string,
  input: SnoozeWorkItemInput,
): Promise<WorkItemMutationResponse> {
  return apiFetch(ROUTES.workItemSnooze(workspaceId, workItemId), {
    method: "POST",
    body: {
      workspaceId,
      workItemId,
      ...input,
    },
    schema: workItemMutationResponseSchema,
    defaultErrorMessage: "Could not snooze the work item.",
  });
}

export function wakeWorkItem(
  workspaceId: string,
  workItemId: string,
): Promise<WorkItemMutationResponse> {
  return apiFetch(ROUTES.workItemWake(workspaceId, workItemId), {
    method: "POST",
    body: {
      workspaceId,
      workItemId,
    },
    schema: workItemMutationResponseSchema,
    defaultErrorMessage: "Could not wake the work item.",
  });
}
