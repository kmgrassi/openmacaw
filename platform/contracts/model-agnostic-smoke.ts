import { z } from "zod";

export const SmokeAgentRoleSchema = z.enum(["planning", "coding"]);

export const SmokeExecutionProfileSchema = z.object({
  name: z.string(),
  agentRole: SmokeAgentRoleSchema,
  runnerKind: z.string(),
  provider: z.string(),
  model: z.string(),
  credentialRef: z.object({
    kind: z.enum(["alias", "id"]),
    value: z.string(),
  }),
  toolProfile: z.string(),
  providerAdapter: z.string(),
  capabilities: z.object({
    toolCalls: z.boolean(),
    structuredOutput: z.boolean(),
  }),
});

export const SmokePlanTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  selectedForCoding: z.boolean(),
});

export const SmokePlanDraftSchema = z.object({
  id: z.string(),
  title: z.string(),
  intent: z.string(),
  createdByProfile: z.string(),
  tasks: z.array(SmokePlanTaskSchema),
});

export const SmokeHandoffSchema = z.object({
  planId: z.string(),
  taskIds: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  receivedByProfile: z.string(),
});

export const SmokeEventSchema = z.object({
  phase: z.enum([
    "planning_profile_resolved",
    "plan_created",
    "tasks_approved",
    "coding_profile_resolved",
    "handoff_received",
  ]),
  agentRole: SmokeAgentRoleSchema,
  executionProfile: z.string(),
  providerAdapter: z.string(),
  message: z.string(),
});

export const ModelAgnosticSmokeResponseSchema = z.object({
  scenario: z.string(),
  liveProviderCalls: z.literal(false),
  profiles: z.object({
    planning: SmokeExecutionProfileSchema,
    coding: SmokeExecutionProfileSchema,
  }),
  planDraft: SmokePlanDraftSchema,
  handoff: SmokeHandoffSchema,
  events: z.array(SmokeEventSchema),
  logs: z.array(z.string()),
});

export type SmokeExecutionProfile = z.infer<typeof SmokeExecutionProfileSchema>;
export type ModelAgnosticSmokeResponse = z.infer<
  typeof ModelAgnosticSmokeResponseSchema
>;
