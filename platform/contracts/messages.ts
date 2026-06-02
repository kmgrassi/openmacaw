import { z } from "zod";

export const KnownAgentMessageRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool",
]);

export const AgentMessageToolCallSchema = z.object({
  id: z.string(),
  toolId: z.string().nullable().optional(),
  input: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});

export const AgentMessageSchema = z.object({
  id: z.string().optional(),
  role: z.string().trim().min(1),
  content: z.string(),
  metadata: z.unknown().optional(),
  toolCalls: z.array(AgentMessageToolCallSchema).default([]),
  timestamp: z.number().optional(),
  createdAt: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  messageType: z.string().nullable().optional(),
});

export const AgentMessagesPageInfoSchema = z.object({
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const AgentMessagesResponseSchema = z.object({
  messages: z.array(AgentMessageSchema),
  pageInfo: AgentMessagesPageInfoSchema,
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type AgentMessageToolCall = z.infer<typeof AgentMessageToolCallSchema>;
export type AgentMessagesResponse = z.infer<typeof AgentMessagesResponseSchema>;
