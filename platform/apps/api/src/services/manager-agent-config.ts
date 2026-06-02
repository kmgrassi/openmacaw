import type { Json, Tables } from "@kmgrassi/supabase-schema";

import {
  ManagerAgentConfigResponseSchema,
  type ManagerAgentConfigRequest,
  type ManagerAgentConfigResponse,
  type ManagerAgentDueTaskQuery,
} from "../../../../contracts/manager-agent.js";
import { ApiRouteError } from "../http.js";
import { findStoredAgentRowById } from "../repositories/agents.js";
import {
  executeSupabaseRows,
  getServiceRoleSupabase,
  getUserScopedSupabase,
  normalizeSupabaseError,
} from "../supabase-client.js";
import { asJson } from "./setup/builders.js";

type JsonRecord = Record<string, unknown>;
type PlanRow = Pick<Tables<"plan">, "id">;
type AgentHeartbeatConfigRow = Pick<
  Tables<"agent_heartbeat_config">,
  "id" | "agent_id" | "workspace_id" | "enabled" | "policy_json" | "tasks_json"
>;

const RUNTIME_DEFAULT_CADENCE_MS = 60_000;
const RUNTIME_DEFAULT_DUE_TASK_QUERY = {
  states: ["running", "awaiting_review"],
  planIds: null,
} satisfies ManagerAgentDueTaskQuery;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function cloneConfig(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(asRecord(value))) as JsonRecord;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function maybeStringArray(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return undefined;
}

function dueTaskQueryFromFilter(value: unknown): ManagerAgentDueTaskQuery {
  const record = asRecord(value);
  const states = maybeStringArray(record.states);
  const planIds = maybeStringArray(record.plan_ids);
  return ManagerAgentConfigResponseSchema.shape.dueTaskQuery.parse({
    ...(states !== undefined ? { states } : {}),
    ...(planIds !== undefined ? { planIds } : {}),
  });
}

function hasField<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function effectiveDueTaskQuery(agent: ManagerAgentDueTaskQuery, workspace: ManagerAgentDueTaskQuery) {
  return ManagerAgentConfigResponseSchema.shape.effectiveDueTaskQuery.parse({
    states: hasField(agent, "states")
      ? agent.states
      : hasField(workspace, "states")
        ? workspace.states
        : RUNTIME_DEFAULT_DUE_TASK_QUERY.states,
    planIds: hasField(agent, "planIds")
      ? agent.planIds
      : hasField(workspace, "planIds")
        ? workspace.planIds
        : RUNTIME_DEFAULT_DUE_TASK_QUERY.planIds,
  });
}

function dueWorkTask(tasksJson: unknown): JsonRecord {
  const tasks = Array.isArray(tasksJson) ? tasksJson : [];
  const task = tasks.find((item) => asRecord(item).kind === "due_work_items");
  return asRecord(task);
}

function responseFromHeartbeatConfig(agentId: string, row: AgentHeartbeatConfigRow | null): ManagerAgentConfigResponse {
  const policy = asRecord(row?.policy_json);
  const cadenceMs = positiveInteger(policy.cadence_ms);
  const workspaceCadenceMs = null;
  const dueTaskQuery = dueTaskQueryFromFilter(dueWorkTask(row?.tasks_json).filter);
  const workspaceDueTaskQuery = dueTaskQueryFromFilter(null);

  return ManagerAgentConfigResponseSchema.parse({
    agentId,
    cadenceMs,
    workspaceCadenceMs,
    dueTaskQuery,
    workspaceDueTaskQuery,
    effectiveCadenceMs: cadenceMs ?? workspaceCadenceMs ?? RUNTIME_DEFAULT_CADENCE_MS,
    effectiveDueTaskQuery: effectiveDueTaskQuery(dueTaskQuery, workspaceDueTaskQuery),
  });
}

async function assertManagerAgentBelongsToWorkspace(accessToken: string, workspaceId: string, agentId: string) {
  const agent = await findStoredAgentRowById(accessToken, agentId);
  if (!agent || agent.workspace_id !== workspaceId || agent.type !== "manager") {
    throw new ApiRouteError(404, "manager_agent_not_found", "Manager agent was not found");
  }
}

async function assertPlanIdsBelongToWorkspace(workspaceId: string, planIds: string[] | null | undefined) {
  if (!planIds || planIds.length === 0) return;
  const uniquePlanIds = [...new Set(planIds)];
  const rows = await executeSupabaseRows<PlanRow>(
    "manager config plan filter validation",
    getServiceRoleSupabase().from("plan").select("id").eq("workspace_id", workspaceId).in("id", uniquePlanIds),
  );
  const found = new Set(rows.map((row) => row.id));
  const missing = uniquePlanIds.filter((planId) => !found.has(planId));
  if (missing.length > 0) {
    throw new ApiRouteError(400, "invalid_plan_filter", "Plan filter contains plans outside this workspace", {
      planIds: missing,
    });
  }
}

function assertNonEmptyPlanOverride(planIds: string[] | null | undefined) {
  if (planIds?.length === 0) {
    throw new ApiRouteError(400, "invalid_plan_filter", "Plan filter override must include at least one plan");
  }
}

function nextDueTaskFilter(filterJson: unknown, dueTaskQuery: ManagerAgentConfigRequest["dueTaskQuery"]) {
  if (dueTaskQuery === undefined) return asRecord(filterJson);
  if (dueTaskQuery === null) {
    return null;
  }

  const filter = { ...asRecord(filterJson) };
  if (hasField(dueTaskQuery, "states")) {
    if (dueTaskQuery.states === null) {
      delete filter.states;
    } else {
      filter.states = dueTaskQuery.states;
    }
  }
  if (hasField(dueTaskQuery, "planIds")) {
    if (dueTaskQuery.planIds === null) {
      delete filter.plan_ids;
    } else {
      filter.plan_ids = dueTaskQuery.planIds;
    }
  }

  return Object.keys(filter).length > 0 ? filter : null;
}

function nextPolicyJson(policyJson: unknown, request: ManagerAgentConfigRequest): JsonRecord {
  const policy = cloneConfig(policyJson);

  if (hasField(request, "cadenceMs")) {
    if (request.cadenceMs === null) {
      delete policy.cadence_ms;
    } else {
      policy.cadence_ms = request.cadenceMs;
    }
  }
  return policy;
}

function nextTasksJson(tasksJson: unknown, request: ManagerAgentConfigRequest): Json[] {
  const existingTasks = Array.isArray(tasksJson) ? tasksJson : [];
  const tasks = existingTasks.map((task) => cloneConfig(task));
  const dueTaskIndex = tasks.findIndex((task) => task.kind === "due_work_items");
  const dueTask: JsonRecord = dueTaskIndex >= 0 ? { ...tasks[dueTaskIndex] } : { kind: "due_work_items" };
  const filter = nextDueTaskFilter(dueTask.filter, request.dueTaskQuery);
  const withoutDueTask = tasks.filter((task) => task.kind !== "due_work_items");
  if (!filter) return withoutDueTask.map(asJson);

  return [
    ...withoutDueTask,
    {
      kind: "due_work_items",
      filter,
    },
  ].map(asJson);
}

function isEmptyHeartbeatPatch(request: ManagerAgentConfigRequest, policyJson: unknown, tasksJson: unknown) {
  return (
    Object.keys(nextPolicyJson(policyJson, request)).length === 0 && nextTasksJson(tasksJson, request).length === 0
  );
}

async function getHeartbeatConfig(input: {
  accessToken: string;
  workspaceId: string;
  agentId: string;
}): Promise<AgentHeartbeatConfigRow | null> {
  const { data, error } = await getUserScopedSupabase(input.accessToken)
    .from("agent_heartbeat_config")
    .select("id,agent_id,workspace_id,enabled,policy_json,tasks_json")
    .eq("workspace_id", input.workspaceId)
    .eq("agent_id", input.agentId)
    .maybeSingle();

  if (error) throw normalizeSupabaseError("agent_heartbeat_config query", error);
  return data;
}

async function upsertHeartbeatConfig(input: {
  accessToken: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  policyJson: JsonRecord;
  tasksJson: Json[];
}): Promise<AgentHeartbeatConfigRow> {
  const { data, error } = await getUserScopedSupabase(input.accessToken)
    .from("agent_heartbeat_config")
    .upsert(
      {
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        policy_json: asJson(input.policyJson),
        tasks_json: input.tasksJson,
        updated_by: input.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,agent_id" },
    )
    .select("id,agent_id,workspace_id,enabled,policy_json,tasks_json")
    .single();

  if (error) throw normalizeSupabaseError("agent_heartbeat_config upsert", error);
  if (!data)
    throw new ApiRouteError(502, "agent_heartbeat_config_save_failed", "Scheduler config save returned no row");
  return data;
}

export async function getManagerAgentConfig(input: {
  accessToken: string;
  workspaceId: string;
  agentId: string;
}): Promise<ManagerAgentConfigResponse> {
  await assertManagerAgentBelongsToWorkspace(input.accessToken, input.workspaceId, input.agentId);
  const existing = await getHeartbeatConfig(input);
  return responseFromHeartbeatConfig(input.agentId, existing);
}

export async function updateManagerAgentConfig(input: {
  accessToken: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  request: ManagerAgentConfigRequest;
}): Promise<ManagerAgentConfigResponse> {
  await assertManagerAgentBelongsToWorkspace(input.accessToken, input.workspaceId, input.agentId);
  assertNonEmptyPlanOverride(input.request.dueTaskQuery?.planIds);
  await assertPlanIdsBelongToWorkspace(input.workspaceId, input.request.dueTaskQuery?.planIds);

  const existing = await getHeartbeatConfig(input);
  if (!existing && isEmptyHeartbeatPatch(input.request, {}, [])) {
    return responseFromHeartbeatConfig(input.agentId, null);
  }
  const saved = await upsertHeartbeatConfig({
    accessToken: input.accessToken,
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    policyJson: nextPolicyJson(existing?.policy_json ?? {}, input.request),
    tasksJson: nextTasksJson(existing?.tasks_json ?? [], input.request),
  });
  return responseFromHeartbeatConfig(input.agentId, saved);
}
