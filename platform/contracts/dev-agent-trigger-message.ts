import { z } from "zod";

export const DevAgentTriggerMessageRequestSchema = z.object({
  workspaceId: z.string().trim().min(1),
  message: z.string().trim().min(1),
  sessionKey: z.string().trim().min(1).optional(),
  waitMs: z.number().int().min(100).max(30_000).default(5_000),
});

export const DevAgentTriggerMessageResponseSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  messageId: z.string().nullable(),
  requestId: z.string(),
  diagnosticBefore: z.object({
    canChat: z.boolean(),
    blockers: z.array(z.string()),
    runnerKind: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    launcherHealthy: z.boolean().nullable(),
  }),
  runtimeObservation: z.object({
    status: z.enum([
      "started",
      "message_accepted",
      "event_observed",
      "blocked",
      "failed",
    ]),
    runId: z.string().nullable(),
    event: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  }),
  messagesAfter: z.object({
    count: z.number().int().nonnegative(),
    latestMessageId: z.string().nullable(),
    latestRole: z.string().nullable(),
    latestCreatedAt: z.string().nullable(),
  }),
  logSummary: z.object({
    available: z.boolean(),
    note: z.string().nullable(),
  }),
});

export type DevAgentTriggerMessageRequest = z.infer<
  typeof DevAgentTriggerMessageRequestSchema
>;
export type DevAgentTriggerMessageResponse = z.infer<
  typeof DevAgentTriggerMessageResponseSchema
>;
