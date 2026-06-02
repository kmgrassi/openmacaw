import {
  AgentToolCallEventCreateRequestSchema,
  type AgentToolCallEvent,
  type AgentToolCallEventCreateRequest,
  type BrokerRun,
  type BrokerTask,
  type GatewayConfigState,
} from "../../../../contracts/agent-dashboard.js";
import { ApiRouteError } from "../http.js";
import {
  getBrokerRunHistoryRows,
  getBrokerTaskForRun,
  getBrokerTaskRows,
  getGatewayConfigStateForScope,
  getLatestBrokerRunRow,
  getToolEventsByTaskId,
  getVisibleBrokerRun,
  getVisibleBrokerRunIds,
  insertAgentToolCallEvent,
  RUN_HISTORY_PAGE_SIZE,
} from "../repositories/agent-dashboard.js";
import { assertDashboardAccess } from "./agent-dashboard/access.js";
import {
  mapAgentToolCallEvent,
  mapBrokerRun,
  mapBrokerTask,
  mapGatewayConfigState,
} from "./agent-dashboard/mappers.js";
import { normalizePage, sanitizeRecord, sanitizeRecordArray, sanitizeSummary } from "./agent-dashboard/sanitize.js";
export { getAgentDashboardVersion } from "./agent-dashboard/version.js";
export { RUN_HISTORY_PAGE_SIZE };

export async function getLatestBrokerRun(input: {
  accessToken: string;
  userId: string;
  agentId: string;
}): Promise<BrokerRun | null> {
  await assertDashboardAccess(input);

  const row = await getLatestBrokerRunRow(input.agentId);
  return row ? mapBrokerRun(row) : null;
}

export async function getBrokerRunHistory(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  page?: number;
}): Promise<{ runs: BrokerRun[]; total: number }> {
  await assertDashboardAccess(input);

  const page = normalizePage(input.page);
  const result = await getBrokerRunHistoryRows({
    agentId: input.agentId,
    offset: page * RUN_HISTORY_PAGE_SIZE,
  });

  return {
    runs: result.rows.map(mapBrokerRun),
    total: result.total,
  };
}

export async function getBrokerTasks(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  runIds: string[];
}): Promise<BrokerTask[]> {
  await assertDashboardAccess(input);
  const uniqueRunIds = Array.from(new Set(input.runIds.map((runId) => runId.trim()).filter(Boolean)));
  if (uniqueRunIds.length === 0) return [];

  const visibleRunIds = await getVisibleBrokerRunIds(input.agentId, uniqueRunIds);
  if (visibleRunIds.size === 0) return [];

  const runIds = Array.from(visibleRunIds);
  const [tasks, eventsByTaskId] = await Promise.all([getBrokerTaskRows(runIds), getToolEventsByTaskId(runIds)]);

  return tasks.map((task) =>
    mapBrokerTask({
      ...task,
      tool_events: eventsByTaskId.get(task.task_id) ?? [],
    }),
  );
}

export async function createAgentToolCallEvent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  event: AgentToolCallEventCreateRequest;
}): Promise<AgentToolCallEvent> {
  const parsed = AgentToolCallEventCreateRequestSchema.parse(input.event);
  const { workspaceId } = await assertDashboardAccess(input);

  const visibleRun = await getVisibleBrokerRun(input.agentId, parsed.runId);
  if (!visibleRun) {
    throw new ApiRouteError(404, "broker_run_not_found", "Run was not found for this agent");
  }
  const runWorkspaceId = visibleRun.workspace_id?.trim() || "";
  if (!runWorkspaceId) {
    throw new ApiRouteError(409, "broker_run_workspace_missing", "Run is not assigned to a workspace");
  }
  if (runWorkspaceId !== workspaceId) {
    throw new ApiRouteError(409, "broker_run_workspace_mismatch", "Run does not belong to the current agent workspace");
  }

  if (parsed.taskId) {
    const task = await getBrokerTaskForRun(parsed.runId, parsed.taskId);
    if (!task) {
      throw new ApiRouteError(404, "broker_task_not_found", "Task was not found for this run");
    }
  }

  const data = await insertAgentToolCallEvent({
    workspace_id: runWorkspaceId,
    agent_id: input.agentId,
    run_id: parsed.runId,
    task_id: parsed.taskId ?? null,
    tool_call_id: sanitizeSummary(parsed.toolCallId) ?? null,
    correlation_id: sanitizeSummary(parsed.correlationId) ?? null,
    sequence: parsed.sequence ?? 0,
    event_type: sanitizeSummary(parsed.eventType) ?? parsed.eventType,
    message_kind: parsed.messageKind,
    tool_slug: sanitizeSummary(parsed.toolSlug) ?? parsed.toolSlug,
    status: parsed.status,
    approval_state: parsed.approvalState,
    command_actions: parsed.commandActions,
    arguments: sanitizeRecord(parsed.arguments),
    result: sanitizeRecord(parsed.result),
    output_summary: sanitizeSummary(parsed.outputSummary),
    patch_summary: sanitizeSummary(parsed.patchSummary),
    file_changes: sanitizeRecordArray(parsed.fileChanges),
    error_code: sanitizeSummary(parsed.errorCode),
    error_message: sanitizeSummary(parsed.errorMessage),
    started_at: parsed.startedAt ?? null,
    completed_at: parsed.completedAt ?? null,
    duration_ms: parsed.durationMs ?? null,
  });
  if (!data) {
    throw new ApiRouteError(502, "agent_tool_call_event_insert_failed", "Could not persist tool call event");
  }

  return mapAgentToolCallEvent(data);
}

export async function getGatewayConfigState(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}): Promise<GatewayConfigState | null> {
  const { workspaceId } = await assertDashboardAccess(input);
  const [agentState, workspaceState] = await Promise.all([
    getGatewayConfigStateForScope("agent", input.agentId),
    getGatewayConfigStateForScope("workspace", workspaceId),
  ]);

  const row = agentState ?? workspaceState;
  return row ? mapGatewayConfigState(row) : null;
}
