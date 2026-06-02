import { z } from "zod";

export const AgentControlMessageKindSchema = z.enum([
  "handoff",
  "control",
  "status",
]);
export const AgentRemediationActionSchema = z.enum([
  "retry",
  "restart",
  "request_credentials",
  "request_user_input",
]);

export const AgentControlMetadataSchema = z
  .record(z.string(), z.unknown())
  .default({});

export const CreateAgentControlMessageRequestSchema = z.object({
  workspaceId: z.string().min(1),
  observerAgentId: z.string().min(1),
  kind: AgentControlMessageKindSchema.default("handoff"),
  subject: z.string().trim().min(1).nullable().optional(),
  body: z.string().trim().min(1),
  metadata: AgentControlMetadataSchema.optional(),
});

export const CreateAgentRemediationRequestSchema = z.object({
  workspaceId: z.string().min(1),
  observerAgentId: z.string().min(1),
  action: AgentRemediationActionSchema,
  reason: z.string().trim().min(1).nullable().optional(),
  metadata: AgentControlMetadataSchema.optional(),
});

export const AgentControlMessageRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  target_agent_id: z.string(),
  observer_agent_id: z.string(),
  kind: AgentControlMessageKindSchema,
  action: AgentRemediationActionSchema.nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  status: z.string(),
  dispatch_status: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  created_at: z.string(),
});

export const AgentControlMessageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  targetAgentId: z.string(),
  observerAgentId: z.string(),
  kind: AgentControlMessageKindSchema,
  action: AgentRemediationActionSchema.nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  status: z.string(),
  dispatchStatus: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
});

export const AgentControlMessageResponseSchema = z.object({
  message: AgentControlMessageSchema,
});

export const AgentRemediationResponseSchema = z.object({
  remediation: AgentControlMessageSchema,
  dispatch: z
    .object({
      attempted: z.boolean(),
      status: z.string(),
      result: z.unknown().nullable(),
    })
    .nullable(),
});

export type AgentControlMessageKind = z.infer<
  typeof AgentControlMessageKindSchema
>;
export type AgentRemediationAction = z.infer<
  typeof AgentRemediationActionSchema
>;
export type CreateAgentControlMessageRequest = z.infer<
  typeof CreateAgentControlMessageRequestSchema
>;
export type CreateAgentRemediationRequest = z.infer<
  typeof CreateAgentRemediationRequestSchema
>;
export type AgentControlMessageRow = z.infer<typeof AgentControlMessageRowSchema>;
export type AgentControlMessage = z.infer<typeof AgentControlMessageSchema>;
