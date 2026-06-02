import { z } from "zod";

export const ManagerRuntimeStatusStateSchema = z.enum([
  "not_created",
  "idle_awaiting_credential",
  "not_running",
  "running",
  "unhealthy",
  "error",
]);

export const ManagerRuntimeStatusSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  status: ManagerRuntimeStatusStateSchema,
  lastTickAt: z.string().nullable(),
  lastDecisionCount: z.number().int().nonnegative().nullable(),
  missing: z.array(z.string()),
  error: z.string().nullable(),
});

export const ManagerRuntimeStatusResponseSchema = z.object({
  manager: ManagerRuntimeStatusSchema,
});

const ManagerStateFilterSchema = z
  .array(
    z.enum([
      "pending",
      "running",
      "awaiting_review",
      "blocked",
      "done",
      "failed",
    ]),
  )
  .min(1);

export const ManagerAgentDueTaskQuerySchema = z.object({
  states: ManagerStateFilterSchema.nullable().optional(),
  planIds: z.array(z.string().uuid()).min(1).nullable().optional(),
});

export const ManagerAgentConfigRequestSchema = z.object({
  cadenceMs: z.number().int().positive().nullable().optional(),
  dueTaskQuery: ManagerAgentDueTaskQuerySchema.nullable().optional(),
});

export const ManagerAgentConfigResponseSchema = z.object({
  agentId: z.string().uuid(),
  cadenceMs: z.number().int().positive().nullable(),
  workspaceCadenceMs: z.number().int().positive().nullable(),
  dueTaskQuery: ManagerAgentDueTaskQuerySchema,
  workspaceDueTaskQuery: ManagerAgentDueTaskQuerySchema,
  effectiveCadenceMs: z.number().int().positive(),
  effectiveDueTaskQuery: ManagerAgentDueTaskQuerySchema,
});

export type ManagerRuntimeStatusState = z.infer<
  typeof ManagerRuntimeStatusStateSchema
>;
export type ManagerRuntimeStatus = z.infer<typeof ManagerRuntimeStatusSchema>;
export type ManagerRuntimeStatusResponse = z.infer<
  typeof ManagerRuntimeStatusResponseSchema
>;
export type ManagerAgentDueTaskQuery = z.infer<
  typeof ManagerAgentDueTaskQuerySchema
>;
export type ManagerAgentConfigRequest = z.infer<
  typeof ManagerAgentConfigRequestSchema
>;
export type ManagerAgentConfigResponse = z.infer<
  typeof ManagerAgentConfigResponseSchema
>;
