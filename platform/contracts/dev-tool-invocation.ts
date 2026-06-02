import { z } from "zod";

import {
  AgentToolCallApprovalStateSchema,
  AgentToolCallMessageKindSchema,
  AgentToolCallStatusSchema,
  LocalCodingCommandActionSchema,
} from "./agent-dashboard.js";

export const DevToolInvocationRequestSchema = z.object({
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  input: z.record(z.string(), z.unknown()).default({}),
  correlationId: z.string().trim().min(1).nullable().optional(),
});

export const DevToolInvocationObservationSchema = z.object({
  toolCallId: z.string().trim().min(1),
  correlationId: z.string().trim().min(1).nullable(),
  eventType: z.string().trim().min(1),
  messageKind: AgentToolCallMessageKindSchema,
  toolSlug: z.string().trim().min(1),
  status: AgentToolCallStatusSchema,
  approvalState: AgentToolCallApprovalStateSchema,
  commandActions: z.array(LocalCodingCommandActionSchema),
  arguments: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  outputSummary: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
});

export const DevToolInvocationResponseSchema = z.object({
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  toolId: z.string().uuid(),
  toolSlug: z.string(),
  toolCallId: z.string(),
  executionProfile: z.object({
    runnerKind: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    missing: z.array(z.string()),
  }),
  observation: DevToolInvocationObservationSchema,
});

export type DevToolInvocationRequest = z.infer<
  typeof DevToolInvocationRequestSchema
>;
export type DevToolInvocationObservation = z.infer<
  typeof DevToolInvocationObservationSchema
>;
export type DevToolInvocationResponse = z.infer<
  typeof DevToolInvocationResponseSchema
>;
