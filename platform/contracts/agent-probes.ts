import { z } from "zod";

import { AgentHealthResponseSchema } from "./agent-health.js";
import { RuntimeDispatchContextSchema } from "./execution-profile.js";
import { KnownExecutionProviderSchema } from "./provider-registry.js";
import { RunnerKindSchema } from "./execution-profile.js";

const ProbeIdSchema = z.string().trim().min(1);
const OptionalProbeIdSchema = ProbeIdSchema.nullable().optional();

export const AgentProbeStatusSchema = z.enum(["passed", "failed", "blocked"]);

export const DiagnosticBlockerCodeSchema = z.enum([
  "agent_not_found",
  "no_routing_rules",
  "routing_rule_mismatch",
  "missing_requirement",
  "local_runtime_helper_missing",
  "local_model_endpoint_unreachable",
  "launcher_unhealthy",
  "claude_code_blocked",
]);

export const DiagnosticBlockerSchema = z.object({
  code: DiagnosticBlockerCodeSchema,
  message: z.string().trim().min(1),
  nextStep: z.string().trim().min(1).optional(),
});

export const AgentProbeDiagnosticSummarySchema = z.object({
  canChat: z.boolean(),
  blockers: z.array(DiagnosticBlockerSchema),
});

export const ToolInvocationProbeErrorCodeSchema = z.enum([
  "tool_not_found",
  "tool_not_granted",
  "tool_input_invalid",
  "tool_execution_failed",
]);

export const ToolInvocationProbeRequestSchema = z.object({
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  input: z.record(z.string(), z.unknown()),
});

export const ToolInvocationProbeResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("passed"),
      agentId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      toolSlug: z.string().trim().min(1),
      toolCallId: ProbeIdSchema,
      result: z.unknown(),
    }),
    z.object({
      status: z.literal("failed"),
      agentId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      toolSlug: z.string().trim().min(1),
      errorCode: ToolInvocationProbeErrorCodeSchema,
      message: z.string().trim().min(1),
      nextStep: z.string().trim().min(1),
    }),
  ],
);

export const AgentScenarioFixtureSchema = z.object({
  scenario: z.string().trim().min(1),
  description: z.string().trim().min(1),
  agentId: OptionalProbeIdSchema,
  workspaceId: OptionalProbeIdSchema,
  runnerKind: RunnerKindSchema.optional(),
  provider: KnownExecutionProviderSchema.optional(),
  expectedTool: z.string().trim().min(1).nullable().optional(),
  expectedDatabaseAssertion: z.string().trim().min(1).nullable().optional(),
  requestId: OptionalProbeIdSchema,
  messageId: OptionalProbeIdSchema,
  runId: OptionalProbeIdSchema,
  toolCallId: OptionalProbeIdSchema,
  preconditions: z.array(z.string().trim().min(1)).default([]),
  actions: z.array(z.string().trim().min(1)).default([]),
  expectedOutcomes: z.array(z.string().trim().min(1)).default([]),
});

export const LogSummaryRecordSchema = z.object({
  timestamp: z.string().trim().min(1),
  layer: z.string().trim().min(1),
  category: z.string().trim().min(1),
  label: z.string().trim().min(1),
  level: z.string().trim().min(1).optional(),
  event: z.string().trim().min(1).optional(),
  method: z.string().trim().min(1).optional(),
  route: z.string().trim().min(1).optional(),
  statusCode: z.number().int().optional(),
  errorCode: z.string().trim().min(1).optional(),
  traceId: z.string().trim().min(1).optional(),
  requestId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
  message: z.string().optional(),
});

export const LogSummaryGroupSchema = z.object({
  key: z.string().trim().min(1),
  count: z.number().int().nonnegative(),
  firstSeen: z.string().trim().min(1),
  lastSeen: z.string().trim().min(1),
  group: z.object({
    traceId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    workspaceId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
    toolCallId: z.string().trim().min(1).optional(),
    route: z.string().trim().min(1).optional(),
    event: z.string().trim().min(1).optional(),
    errorCode: z.string().trim().min(1).optional(),
    layer: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
  }),
  records: z.array(LogSummaryRecordSchema),
});

export const LogSummarySnapshotSchema = z.object({
  status: z.enum(["ok", "warn"]),
  since: z.string().trim().min(1),
  filters: z
    .object({
      agentId: z.string().trim().min(1).optional(),
      workspaceId: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  files: z.array(
    z.object({
      layer: z.string().trim().min(1),
      path: z.string().trim().min(1),
      exists: z.boolean(),
      size: z.number().int().nonnegative(),
      mtime: z.string().trim().min(1).optional(),
    }),
  ),
  warnings: z.array(z.string()),
  summary: z.object({
    totalRecords: z.number().int().nonnegative(),
    warningOrErrorRecords: z.number().int().nonnegative(),
    groups: z.number().int().nonnegative(),
  }),
  highlights: z.record(z.string(), LogSummaryRecordSchema),
  groups: z.array(LogSummaryGroupSchema),
  recentRecords: z.array(LogSummaryRecordSchema),
});

export const SupportArtifactRedactionSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string(),
  redacted: z.boolean(),
});

export const AgentDispatchDryRunResponseSchema = z.object({
  status: AgentProbeStatusSchema,
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  requestId: ProbeIdSchema.optional(),
  diagnosticBefore: AgentProbeDiagnosticSummarySchema.optional(),
  health: AgentHealthResponseSchema.optional(),
  dispatch: RuntimeDispatchContextSchema,
});

export type AgentProbeStatus = z.infer<typeof AgentProbeStatusSchema>;
export type DiagnosticBlockerCode = z.infer<typeof DiagnosticBlockerCodeSchema>;
export type DiagnosticBlocker = z.infer<typeof DiagnosticBlockerSchema>;
export type AgentProbeDiagnosticSummary = z.infer<
  typeof AgentProbeDiagnosticSummarySchema
>;
export type ToolInvocationProbeErrorCode = z.infer<
  typeof ToolInvocationProbeErrorCodeSchema
>;
export type ToolInvocationProbeRequest = z.infer<
  typeof ToolInvocationProbeRequestSchema
>;
export type ToolInvocationProbeResponse = z.infer<
  typeof ToolInvocationProbeResponseSchema
>;
export type AgentScenarioFixture = z.infer<typeof AgentScenarioFixtureSchema>;
export type LogSummaryRecord = z.infer<typeof LogSummaryRecordSchema>;
export type LogSummaryGroup = z.infer<typeof LogSummaryGroupSchema>;
export type LogSummarySnapshot = z.infer<typeof LogSummarySnapshotSchema>;
export type SupportArtifactRedaction = z.infer<
  typeof SupportArtifactRedactionSchema
>;
export type AgentDispatchDryRunResponse = z.infer<
  typeof AgentDispatchDryRunResponseSchema
>;
