import { z } from "zod";

import {
  ExecutionProfileCapabilitiesSchema,
  RuntimeExecutionTargetSchema,
  RuntimeWorkspacePolicySchema,
} from "./execution-profile.js";
import { ToolDefinitionSchema } from "./tool-definition.js";

export const AgentDispatchProbeRequestSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const AgentDispatchProbeCredentialSchema = z.object({
  resolved: z.boolean(),
  refType: z.enum(["credential_id", "alias"]).nullable(),
});

export const AgentDispatchProbeProfileSchema = z.object({
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  role: z.enum(["planning", "coding", "manager", "custom"]),
  runnerKind: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  toolProfile: z.enum(["planning", "coding", "manager", "none"]),
  credential: AgentDispatchProbeCredentialSchema,
  capabilities: ExecutionProfileCapabilitiesSchema,
});

export const AgentDispatchProbeRuntimePayloadSchema = z.object({
  body: z.record(z.string(), z.unknown()),
});

export const AgentDispatchDryRunResponseSchema = z.object({
  status: z.literal("ready"),
  mode: z.literal("dryRun"),
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  resolvedAt: z.string(),
  platform: z.object({
    profile: AgentDispatchProbeProfileSchema,
    source: z.object({
      routingRuleId: z.string().uuid().nullable(),
      credentialAlias: z.string().nullable(),
      fallbackUsed: z.boolean(),
      legacyGatewayConfigUsed: z.boolean(),
    }),
    toolDefinitions: z.array(ToolDefinitionSchema),
    workspacePolicy: RuntimeWorkspacePolicySchema.nullable(),
    executionTarget: RuntimeExecutionTargetSchema.nullable(),
  }),
  runtimePayload: AgentDispatchProbeRuntimePayloadSchema,
});

export const AgentDispatchConfigComparisonSchema = z.object({
  field: z.enum(["runnerKind", "provider", "model", "toolProfile"]),
  platformValue: z.string().nullable(),
  runtimeValue: z.string().nullable(),
  matches: z.boolean(),
});

export const AgentDispatchLiveResponseSchema = z.object({
  status: z.enum(["matched", "mismatch"]),
  mode: z.literal("live"),
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  resolvedAt: z.string(),
  runtimeTarget: z.object({
    id: z.string(),
    port: z.number(),
    status: z.string(),
    reused: z.boolean(),
    agentId: z.string().nullable(),
    workspaceId: z.string().nullable(),
  }),
  firstObservedRuntimeState: z.unknown(),
  platform: AgentDispatchDryRunResponseSchema.shape.platform,
  runtimeReported: z.object({
    runnerKind: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    toolProfile: z.string().nullable(),
  }),
  comparisons: z.array(AgentDispatchConfigComparisonSchema),
});

export type AgentDispatchProbeRequest = z.infer<
  typeof AgentDispatchProbeRequestSchema
>;
export type AgentDispatchDryRunResponse = z.infer<
  typeof AgentDispatchDryRunResponseSchema
>;
export type AgentDispatchLiveResponse = z.infer<
  typeof AgentDispatchLiveResponseSchema
>;
