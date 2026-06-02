import type {
  AgentToolCallEvent,
  BrokerRun,
  BrokerTask,
  GatewayConfigState,
} from "../../../../../contracts/agent-dashboard.js";
import type {
  AgentToolCallEventRow,
  BrokerRunRow,
  BrokerTaskRow,
  GatewayConfigStateRow,
} from "../../repositories/agent-dashboard.js";

export function mapBrokerRun(row: BrokerRunRow): BrokerRun {
  return {
    runId: row.run_id,
    agentId: row.agent_id,
    attempt: row.attempt,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    error: row.error,
    terminalReason: row.terminal_reason,
    trackerKind: row.tracker_kind,
    trackerIssueKey: row.tracker_issue_key,
    issueIdentifier: row.issue_identifier,
    issueState: row.issue_state,
    updatedAt: row.updated_at,
  };
}

export function mapAgentToolCallEvent(row: AgentToolCallEventRow): AgentToolCallEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    runId: row.run_id,
    taskId: row.task_id,
    toolCallId: row.tool_call_id ?? null,
    correlationId: row.correlation_id ?? null,
    sequence: row.sequence,
    eventType: row.event_type,
    messageKind: row.message_kind ?? "assistant_tool_call",
    toolSlug: row.tool_slug,
    status: row.status,
    approvalState: row.approval_state ?? "not_required",
    commandActions: row.command_actions ?? [],
    arguments: row.arguments ?? {},
    result: row.result ?? {},
    outputSummary: row.output_summary,
    patchSummary: row.patch_summary,
    fileChanges: row.file_changes,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapBrokerTask(row: BrokerTaskRow): BrokerTask {
  return {
    taskId: row.task_id,
    runId: row.run_id,
    attempt: row.attempt,
    status: row.status,
    type: row.type,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    lastEvent: row.last_event,
    lastEventAt: row.last_event_at,
    error: row.error,
    updatedAt: row.updated_at,
    toolEvents: (row.tool_events ?? []).map(mapAgentToolCallEvent),
  };
}

export function mapGatewayConfigState(row: GatewayConfigStateRow): GatewayConfigState {
  return {
    scopeType: row.scope_type as GatewayConfigState["scopeType"],
    scopeId: row.scope_id,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    lastApplyStatus: row.last_apply_status,
    lastApplyError: row.last_apply_error,
    lastApplyAt: row.last_apply_at,
    lastAppliedVersion: row.last_applied_version,
  };
}
