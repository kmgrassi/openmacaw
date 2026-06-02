import { z } from "zod";

export const LearningMemoryStatusResponseSchema = z.object({
  workspaceId: z.string(),
  learningEnabled: z.boolean(),
  hasEmbeddedMemories: z.boolean(),
});

export const LearningProviderWarningTelemetryRequestSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  fromProvider: z.string().nullable(),
  toProvider: z.string().nullable(),
  action: z.enum(["shown", "cancelled", "confirmed"]),
});

export type LearningMemoryStatusResponse = z.infer<
  typeof LearningMemoryStatusResponseSchema
>;

export type LearningProviderWarningTelemetryRequest = z.infer<
  typeof LearningProviderWarningTelemetryRequestSchema
>;
