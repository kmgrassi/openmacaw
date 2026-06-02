import { z } from "zod";

export const ClaudeCodeSmokeProfileSchema = z.object({
  name: z.string(),
  agentRole: z.enum(["planning", "coding"]),
  runnerKind: z.string(),
  provider: z.string(),
  model: z.string(),
  credentialRef: z.object({
    kind: z.literal("alias"),
    value: z.string(),
  }),
  toolProfile: z.string(),
});

export const ClaudeCodeSmokeWorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["created", "dispatched", "completed"]),
  assignedAgentProfile: z.string(),
});

export const ClaudeCodeSmokeRuntimeProfileSchema = z.object({
  role: z.literal("coding"),
  runner_kind: z.literal("claude_code"),
  provider: z.literal("anthropic"),
  model: z.string(),
  credential_ref: z.string(),
  tool_profile: z.literal("coding"),
});

export const ClaudeCodeSmokeDispatchSchema = z.object({
  planId: z.string(),
  workItemId: z.string(),
  routedToProfile: z.string(),
  runtimeProfile: ClaudeCodeSmokeRuntimeProfileSchema,
});

export const ClaudeCodeSmokeEventSchema = z.object({
  kind: z.enum([
    "assistant_delta",
    "tool_started",
    "tool_completed",
    "turn_completed",
    "usage_reported",
  ]),
  label: z.string(),
  runnerKind: z.literal("claude_code"),
  provider: z.literal("anthropic"),
  visibleInDashboard: z.literal(true),
});

export const ClaudeCodeSmokeWorkspaceEvidenceSchema = z.object({
  diffSummary: z.string(),
  logLines: z.array(z.string()),
});

export const ClaudeCodeSmokeResponseSchema = z.object({
  scenario: z.literal("planning-agent-to-claude-code-coding-dispatch"),
  liveProviderCalls: z.literal(false),
  profiles: z.object({
    planning: ClaudeCodeSmokeProfileSchema,
    coding: ClaudeCodeSmokeProfileSchema,
  }),
  plan: z.object({
    id: z.string(),
    title: z.string(),
    createdByProfile: z.string(),
  }),
  workItem: ClaudeCodeSmokeWorkItemSchema,
  dispatch: ClaudeCodeSmokeDispatchSchema,
  normalizedEvents: z.array(ClaudeCodeSmokeEventSchema),
  workspaceEvidence: ClaudeCodeSmokeWorkspaceEvidenceSchema,
});

export type ClaudeCodeSmokeResponse = z.infer<
  typeof ClaudeCodeSmokeResponseSchema
>;
