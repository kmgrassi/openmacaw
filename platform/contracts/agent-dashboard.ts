import { z } from "zod";

export const AgentDashboardVersionResponseSchema = z.object({
  version: z.string(),
  latestEventAt: z.string().nullable(),
  pollAfterMs: z.number().int().positive(),
});

export type AgentDashboardVersionResponse = z.infer<
  typeof AgentDashboardVersionResponseSchema
>;

export const RUN_HISTORY_PAGE_SIZE = 8;

export const BrokerRunSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  attempt: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  status: z.string().nullable(),
  error: z.string().nullable(),
  terminalReason: z.string().nullable(),
  trackerKind: z.string().nullable(),
  trackerIssueKey: z.string().nullable(),
  issueIdentifier: z.string().nullable(),
  issueState: z.string().nullable(),
  updatedAt: z.string(),
});

export const LocalCodingCommandActionSchema = z.enum([
  "read",
  "list_files",
  "search",
  "unknown",
]);

export const AgentToolCallMessageKindSchema = z.enum([
  "model_text",
  "assistant_tool_call",
  "tool_result",
  "final_assistant_response",
]);

export const AgentToolCallStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "approval_required",
]);

export const AgentToolCallApprovalStateSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "rejected",
  "expired",
]);

export const AgentToolCallEventSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  runId: z.string(),
  taskId: z.string().nullable(),
  toolCallId: z.string().nullable(),
  correlationId: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  eventType: z.string(),
  messageKind: AgentToolCallMessageKindSchema,
  toolSlug: z.string(),
  status: AgentToolCallStatusSchema,
  approvalState: AgentToolCallApprovalStateSchema,
  commandActions: z.array(LocalCodingCommandActionSchema),
  arguments: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  outputSummary: z.string().nullable(),
  patchSummary: z.string().nullable(),
  fileChanges: z.array(z.record(z.string(), z.unknown())),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const BrokerTaskSchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  attempt: z.number().int().nullable(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  lastEvent: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
  toolEvents: z.array(AgentToolCallEventSchema).default([]),
});

export const GatewayConfigStateSchema = z.object({
  scopeType: z.enum(["agent", "workspace"]),
  scopeId: z.string(),
  syncStatus: z.string().nullable(),
  syncError: z.string().nullable(),
  lastApplyStatus: z.string().nullable(),
  lastApplyError: z.string().nullable(),
  lastApplyAt: z.string().nullable(),
  lastAppliedVersion: z.number().int().nullable(),
});

export const LatestBrokerRunResponseSchema = z.object({
  run: BrokerRunSchema.nullable(),
});

export const BrokerRunHistoryResponseSchema = z.object({
  runs: z.array(BrokerRunSchema),
  total: z.number().int().nonnegative(),
});

export const BrokerTaskListRequestSchema = z.object({
  runIds: z.array(z.string()).max(32),
});

export const BrokerTaskListResponseSchema = z.object({
  tasks: z.array(BrokerTaskSchema),
});

export const AgentToolCallEventCreateRequestSchema = z.object({
  runId: z.string().trim().min(1),
  taskId: z.string().trim().min(1).nullable().optional(),
  toolCallId: z.string().trim().min(1).nullable().optional(),
  correlationId: z.string().trim().min(1).nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  eventType: z.string().trim().min(1),
  messageKind: AgentToolCallMessageKindSchema.default("assistant_tool_call"),
  toolSlug: z.string().trim().min(1),
  status: AgentToolCallStatusSchema,
  approvalState: AgentToolCallApprovalStateSchema.default("not_required"),
  commandActions: z.array(LocalCodingCommandActionSchema).default([]),
  arguments: z.record(z.string(), z.unknown()).default({}),
  result: z.record(z.string(), z.unknown()).default({}),
  outputSummary: z.string().trim().min(1).nullable().optional(),
  patchSummary: z.string().trim().min(1).nullable().optional(),
  fileChanges: z.array(z.record(z.string(), z.unknown())).default([]),
  errorCode: z.string().trim().min(1).nullable().optional(),
  errorMessage: z.string().trim().min(1).nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
});

export const AgentToolCallEventCreateResponseSchema = z.object({
  event: AgentToolCallEventSchema,
});

export const GatewayConfigStateResponseSchema = z.object({
  state: GatewayConfigStateSchema.nullable(),
});

export const AgentDashboardResponseSchema = z.object({
  latestRun: BrokerRunSchema.nullable(),
  tasks: z.array(BrokerTaskSchema),
  configState: GatewayConfigStateSchema.nullable(),
});

export const AgentDashboardRunsResponseSchema = z.object({
  runs: z.array(BrokerRunSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
});

export const AgentDashboardEventsResponseSchema = z.object({
  events: z.array(z.never()),
});

export type BrokerRun = z.infer<typeof BrokerRunSchema>;
export type BrokerTask = z.infer<typeof BrokerTaskSchema>;
export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;
export type AgentToolCallEventCreateRequest = z.infer<
  typeof AgentToolCallEventCreateRequestSchema
>;
export type GatewayConfigState = z.infer<typeof GatewayConfigStateSchema>;
export type BrokerRunHistoryResponse = z.infer<
  typeof BrokerRunHistoryResponseSchema
>;
export type AgentDashboardResponse = z.infer<
  typeof AgentDashboardResponseSchema
>;
export type AgentDashboardRunsResponse = z.infer<
  typeof AgentDashboardRunsResponseSchema
>;
export type AgentDashboardEventsResponse = z.infer<
  typeof AgentDashboardEventsResponseSchema
>;
