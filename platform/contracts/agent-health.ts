import { z } from "zod";

import { RunnerKindSchema } from "./execution-profile.js";

export const AgentHealthLayerSchema = z.enum([
  "config",
  "launcher",
  "database",
  "gateway",
  "runtime",
  "model",
  "tool",
]);

export const AgentHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "unhealthy",
  "unknown",
]);

export const DiagnosticErrorCodes = [
  "gateway_config_missing",
  "execution_profile_unresolved",
  "credential_missing",
  "runner_spawn_failed",
  "cleanup_failed",
  "timeout",
] as const;

export const DiagnosticErrorCodeSchema = z.enum(DiagnosticErrorCodes);

export const AgentHealthFailureSchema = z.object({
  sourceLayer: AgentHealthLayerSchema,
  code: z.string().min(1),
  message: z.string().min(1),
  occurredAt: z.string().nullable(),
  retryable: z.boolean().nullable(),
});

export const AgentHealthConfigSchema = z.object({
  configured: z.boolean(),
  missing: z.array(z.string()),
  gatewaySyncStatus: z.string().nullable(),
  gatewayApplyStatus: z.string().nullable(),
  lastError: AgentHealthFailureSchema.nullable(),
});

export const AgentHealthLauncherSchema = z.object({
  reachable: z.boolean(),
  status: z.string(),
  service: z.string().nullable(),
  lastError: AgentHealthFailureSchema.nullable(),
});

export const AgentHealthRuntimeSchema = z.object({
  state: z.string(),
  engineStatus: z.string().nullable(),
  instanceId: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  lastError: AgentHealthFailureSchema.nullable(),
});

export const AgentHealthDatabaseSchema = z.object({
  configured: z.boolean().nullable(),
  started: z.boolean().nullable(),
  connected: z.boolean().nullable(),
  status: z.string(),
  source: z.string().nullable(),
  lastError: AgentHealthFailureSchema.nullable(),
});

export const AgentHealthResponseSchema = z.object({
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  checkedAt: z.string(),
  status: AgentHealthStatusSchema,
  config: AgentHealthConfigSchema,
  launcher: AgentHealthLauncherSchema,
  database: AgentHealthDatabaseSchema,
  runtime: AgentHealthRuntimeSchema,
  lastFailure: AgentHealthFailureSchema.nullable(),
});

export const WorkspaceAgentDiagnosticStatusSchema = z.enum(["ok", "error", "pending"]);

export const WorkspaceAgentDiagnosticRuntimeStatusSchema = z.enum(["ready", "not_ready", "timeout"]);

export const WorkspaceAgentDiagnosticRuntimeAgentSchema = z.object({
  agent_id: z.string().uuid(),
  runner_kind: RunnerKindSchema,
  status: WorkspaceAgentDiagnosticRuntimeStatusSchema,
  reason: DiagnosticErrorCodeSchema.optional(),
  details: z.unknown().optional(),
});

export const WorkspaceAgentDiagnosticRuntimeResponseSchema = z.object({
  workspace_id: z.string().uuid(),
  agents: z.array(WorkspaceAgentDiagnosticRuntimeAgentSchema),
});

export const WorkspaceAgentDiagnosticAgentSchema = z.object({
  agentId: z.string().uuid(),
  runnerKind: RunnerKindSchema,
  status: WorkspaceAgentDiagnosticStatusSchema,
  errorCode: DiagnosticErrorCodeSchema.optional(),
  errorDetails: z.unknown().optional(),
});

export const WorkspaceAgentDiagnosticSuccessResponseSchema = z.object({
  ok: z.literal(true),
  workspaceId: z.string().uuid(),
  agents: z.array(WorkspaceAgentDiagnosticAgentSchema),
});

export const WorkspaceAgentDiagnosticUnavailableResponseSchema = z.object({
  ok: z.literal(false),
  reason: z.literal("runtime_unreachable"),
  details: z.string().min(1),
});

export const WorkspaceAgentDiagnosticResponseSchema = z.discriminatedUnion("ok", [
  WorkspaceAgentDiagnosticSuccessResponseSchema,
  WorkspaceAgentDiagnosticUnavailableResponseSchema,
]);

export type AgentHealthLayer = z.infer<typeof AgentHealthLayerSchema>;
export type AgentHealthStatus = z.infer<typeof AgentHealthStatusSchema>;
export type DiagnosticErrorCode = z.infer<typeof DiagnosticErrorCodeSchema>;
export type AgentHealthFailure = z.infer<typeof AgentHealthFailureSchema>;
export type AgentHealthResponse = z.infer<typeof AgentHealthResponseSchema>;
export type WorkspaceAgentDiagnosticStatus = z.infer<typeof WorkspaceAgentDiagnosticStatusSchema>;
export type WorkspaceAgentDiagnosticResponse = z.infer<typeof WorkspaceAgentDiagnosticResponseSchema>;
