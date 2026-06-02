import { z } from "zod";

export const WORK_ITEM_SOURCES = [
  "api",
  "github",
  "linear",
  "planner",
  "task",
] as const;
export const WorkItemSourceSchema = z.enum(WORK_ITEM_SOURCES);

export const ManualWorkItemRequestSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().trim().nullable().optional(),
  planId: z.string().trim().nullable().optional(),
  priority: z.string().trim().nullable().optional(),
  labels: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  state: z.string().min(1).optional(),
});

export const WorkItemSnoozeActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().uuid() }),
  z.object({ kind: z.literal("agent"), agentId: z.string().uuid() }),
]);

export const WorkItemSnoozeProjectionSchema = z.object({
  indefinite: z.boolean(),
  reason: z.string().nullable(),
  snoozedAt: z.string().datetime(),
  snoozedBy: WorkItemSnoozeActorSchema,
});

export const WorkItemProjectionSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  planId: z.string().nullable(),
  identifier: z.string().optional(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  instructions: z.string().nullable().optional(),
  state: z.string(),
  priority: z.string().nullable(),
  source: WorkItemSourceSchema,
  runnerKind: z.string().nullable().optional().default(null),
  repository: z.string().nullable().optional().default(null),
  labels: z.array(z.string()),
  dependsOn: z.array(z.string()).optional(),
  completionGates: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()),
  nextPollAt: z.string().datetime().nullable(),
  lastPolledAt: z.string().datetime().nullable(),
  pollCadenceSeconds: z.number().int().positive(),
  snooze: WorkItemSnoozeProjectionSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const WorkItemIngestResponseSchema = z.object({
  workItem: WorkItemProjectionSchema.nullable(),
});

export const WorkItemListResponseSchema = z.object({
  workItems: z.array(WorkItemProjectionSchema),
});

export const WorkItemDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  workItem: WorkItemProjectionSchema,
});

export type ManualWorkItemRequest = z.infer<typeof ManualWorkItemRequestSchema>;
export type WorkItemSource = z.infer<typeof WorkItemSourceSchema>;
export type WorkItemSnoozeActor = z.infer<typeof WorkItemSnoozeActorSchema>;
export type WorkItemSnoozeProjection = z.infer<
  typeof WorkItemSnoozeProjectionSchema
>;
export type WorkItemProjection = z.infer<typeof WorkItemProjectionSchema>;
export type WorkItemIngestResponse = z.infer<
  typeof WorkItemIngestResponseSchema
>;
export type WorkItemListResponse = z.infer<typeof WorkItemListResponseSchema>;
export type WorkItemDeleteResponse = z.infer<
  typeof WorkItemDeleteResponseSchema
>;
