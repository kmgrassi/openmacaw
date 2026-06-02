import type { Tables } from "@kmgrassi/supabase-schema";
import type { ManagerRuntimeStatus, ManagerRuntimeStatusState } from "../../../../contracts/manager-agent.js";
import { ApiRouteError } from "../http.js";
import { executeLoggedSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";
import type { UpstreamResponse } from "./upstream.js";

type ManagerAgentRow = Pick<Tables<"agent">, "id" | "workspace_id" | "status" | "type" | "updated_at">;

type ManagerStatusInput = {
  workspaceId: string;
  userId: string;
  runtimeRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>;
};

const MANAGER_AGENT_SELECT = "id,workspace_id,status,type,updated_at" as const;
const RUNTIME_STATUS_PATH = "/api/runtime/manager-status";

function emptyStatus(
  workspaceId: string,
  agentId: string | null,
  status: ManagerRuntimeStatusState,
  error: string | null = null,
): ManagerRuntimeStatus {
  return {
    workspaceId,
    agentId,
    status,
    lastTickAt: null,
    lastDecisionCount: null,
    missing: [],
    error,
  };
}

function isWorkspaceAuthorizationMiss(error: unknown) {
  return error instanceof Error && error.message === "Authenticated user is not authorized for the requested workspace";
}

async function assertManagerWorkspaceAccess(userId: string, workspaceId: string) {
  try {
    await assertWorkspaceMembership(userId, workspaceId);
  } catch (error) {
    if (isWorkspaceAuthorizationMiss(error)) {
      throw new ApiRouteError(403, "workspace_forbidden", "User is not authorized for the target workspace");
    }

    throw new ApiRouteError(
      502,
      "workspace_membership_check_failed",
      "Could not verify workspace membership",
      String(error),
    );
  }
}

async function findWorkspaceManagerAgent(workspaceId: string): Promise<ManagerAgentRow | null> {
  const rows = await executeLoggedSupabaseRows<ManagerAgentRow>(
    {
      operation: "manager_runtime_status.find_workspace_manager_agent",
      table: "agent",
    },
    getServiceRoleSupabase()
      .from("agent")
      .select(MANAGER_AGENT_SELECT)
      .eq("workspace_id", workspaceId)
      .eq("type", "manager")
      .order("updated_at", { ascending: false })
      .limit(1),
  );

  return rows[0] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter((entry): entry is string => Boolean(entry)) : [];
}

function normalizeRuntimeState(value: unknown, missing: string[]): ManagerRuntimeStatusState {
  switch (value) {
    case "not_created":
    case "idle_awaiting_credential":
    case "not_running":
    case "running":
    case "unhealthy":
    case "error":
      return value;
    case "idle":
      return missing.includes("credential") ? "idle_awaiting_credential" : "not_running";
    case "failed":
    case "failing":
      return "unhealthy";
    default:
      return missing.includes("credential") ? "idle_awaiting_credential" : "error";
  }
}

function responseError(body: Record<string, unknown>): string | null {
  const direct = stringValue(body.error);
  if (direct) return direct;

  const nested = asRecord(body.error);
  return stringValue(nested.message) ?? stringValue(body.message);
}

export function normalizeManagerRuntimeStatus(
  workspaceId: string,
  managerAgentId: string,
  body: unknown,
): ManagerRuntimeStatus {
  const record = asRecord(body);
  const nested = asRecord(record.manager);
  const source = Object.keys(nested).length > 0 ? nested : record;
  const missing = stringArrayValue(source.missing);

  return {
    workspaceId,
    agentId: managerAgentId,
    status: normalizeRuntimeState(source.status, missing),
    lastTickAt: stringValue(source.lastTickAt) ?? stringValue(source.last_tick_at),
    lastDecisionCount: numberValue(source.lastDecisionCount) ?? numberValue(source.last_decision_count),
    missing,
    error: responseError(source),
  };
}

function managerStatusForRuntimeError(
  workspaceId: string,
  managerAgentId: string,
  error: unknown,
): ManagerRuntimeStatus {
  if (error instanceof Error && error.name === "AbortError") {
    return emptyStatus(workspaceId, managerAgentId, "not_running", "Manager runtime request timed out");
  }

  return emptyStatus(
    workspaceId,
    managerAgentId,
    "not_running",
    error instanceof Error ? error.message : String(error),
  );
}

function managerStatusForUpstreamFailure(
  workspaceId: string,
  managerAgentId: string,
  response: UpstreamResponse,
): ManagerRuntimeStatus {
  const body = asRecord(response.body);
  const status = response.status === 404 ? "not_running" : response.status >= 500 ? "unhealthy" : "error";
  return emptyStatus(
    workspaceId,
    managerAgentId,
    status,
    responseError(body) ?? `Manager runtime returned HTTP ${response.status}`,
  );
}

export async function getManagerRuntimeStatus(input: ManagerStatusInput): Promise<ManagerRuntimeStatus> {
  await assertManagerWorkspaceAccess(input.userId, input.workspaceId);

  const managerAgent = await findWorkspaceManagerAgent(input.workspaceId);

  if (!managerAgent) {
    return emptyStatus(input.workspaceId, null, "not_created");
  }
  if (managerAgent.status !== "active") {
    return emptyStatus(input.workspaceId, managerAgent.id, "not_running");
  }

  const path = `${RUNTIME_STATUS_PATH}?workspace_id=${encodeURIComponent(input.workspaceId)}`;

  try {
    const response = await input.runtimeRequest(path, { method: "GET" });
    if (response.status < 200 || response.status >= 300) {
      return managerStatusForUpstreamFailure(input.workspaceId, managerAgent.id, response);
    }

    return normalizeManagerRuntimeStatus(input.workspaceId, managerAgent.id, response.body);
  } catch (error) {
    return managerStatusForRuntimeError(input.workspaceId, managerAgent.id, error);
  }
}
