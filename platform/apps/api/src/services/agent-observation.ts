import {
  AgentObservationResponseSchema,
  normalizeAgentType,
  type AgentObservationEvent,
  type AgentObservationResponse,
} from "../../../../contracts/agents.js";
import type { Tables } from "@kmgrassi/supabase-schema";
import { ApiRouteError } from "../http.js";
import { findSetupAgentById } from "../repositories/agents.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import type { LauncherClient } from "./launcher.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";

type EngineInstanceObservationRow = Pick<
  Tables<"engine_instance">,
  "instance_id" | "status" | "last_health_at" | "updated_at"
>;
type GatewayConfigObservationRow = Pick<
  Tables<"gateway_config_state">,
  "sync_status" | "sync_error" | "last_apply_status" | "last_apply_error" | "last_apply_at" | "synced_at"
>;
type BrokerRunObservationRow = Pick<
  Tables<"broker_run">,
  "run_id" | "status" | "started_at" | "completed_at" | "updated_at" | "created_at" | "error" | "terminal_reason"
>;
type BrokerTaskObservationRow = Pick<
  Tables<"broker_task">,
  "task_id" | "run_id" | "status" | "type" | "last_event" | "last_event_at" | "error" | "updated_at"
>;

type ObservationInput = {
  accessToken: string;
  userId: string;
  targetAgentId: string;
  observerAgentId?: string | null;
  limit?: number;
  launcherClient: LauncherClient;
};

function clampLimit(value: number | undefined) {
  if (!Number.isFinite(value ?? NaN)) return 20;
  return Math.min(Math.max(Math.trunc(value ?? 20), 1), 50);
}

function latestTimestamp(...values: Array<string | null | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0) ?? null;
}

function summarizeRun(run: BrokerRunObservationRow): AgentObservationEvent {
  const failed = Boolean(run.error || run.terminal_reason || ["failed", "error", "cancelled"].includes(run.status));
  return {
    event: failed ? "run_failed" : "run_status",
    source: "runtime",
    severity: failed ? "error" : "info",
    occurredAt: latestTimestamp(run.completed_at, run.updated_at, run.started_at, run.created_at),
    summary: failed ? `Run ${run.status}: ${run.terminal_reason ?? run.error ?? "failed"}` : `Run ${run.status}`,
    runId: run.run_id,
    error: run.error,
  };
}

function summarizeTask(task: BrokerTaskObservationRow): AgentObservationEvent {
  const failed = Boolean(task.error || ["failed", "error", "cancelled"].includes(task.status));
  return {
    event: failed ? "tool_call_failed" : task.last_event || "tool_call_status",
    source: "tool",
    severity: failed ? "error" : "info",
    occurredAt: latestTimestamp(task.last_event_at, task.updated_at),
    summary: failed ? `${task.type} ${task.status}: ${task.error ?? "failed"}` : `${task.type} ${task.status}`,
    runId: task.run_id,
    taskId: task.task_id,
    error: task.error,
  };
}

function summarizeConfig(config: GatewayConfigObservationRow | null): AgentObservationEvent | null {
  if (!config) return null;
  const error = config.last_apply_error ?? config.sync_error;
  if (!error) return null;

  return {
    event: "gateway_config_failed",
    source: "gateway",
    severity: "error",
    occurredAt: latestTimestamp(config.last_apply_at, config.synced_at),
    summary: `Gateway config ${config.last_apply_status ?? config.sync_status}: ${error}`,
    error,
  };
}

function isWorkspaceAuthorizationMiss(error: unknown) {
  return error instanceof Error && error.message === "Authenticated user is not authorized for the requested workspace";
}

async function getLatestEngineInstance(agentId: string) {
  const rows = await executeSupabaseRows<EngineInstanceObservationRow>(
    "engine_instance query",
    getServiceRoleSupabase()
      .from("engine_instance")
      .select("instance_id,status,last_health_at,updated_at")
      .eq("agent_id", agentId)
      .order("updated_at", { ascending: false })
      .limit(1),
  );

  return (rows[0] as EngineInstanceObservationRow | undefined) ?? null;
}

async function getGatewayConfig(agentId: string, workspaceId: string) {
  const rows = await executeSupabaseRows<GatewayConfigObservationRow>(
    "gateway_config_state query",
    getServiceRoleSupabase()
      .from("gateway_config_state")
      .select("sync_status,sync_error,last_apply_status,last_apply_error,last_apply_at,synced_at")
      .or(
        [
          "and(scope_type.eq.agent,scope_id.eq." + agentId + ")",
          "and(scope_type.eq.workspace,scope_id.eq." + workspaceId + ")",
        ].join(","),
      )
      .order("scope_type", { ascending: true })
      .limit(2),
  );

  return (rows[0] as GatewayConfigObservationRow | undefined) ?? null;
}

async function getRecentRuns(agentId: string, limit: number) {
  const rows = await executeSupabaseRows<BrokerRunObservationRow>(
    "broker_run query",
    getServiceRoleSupabase()
      .from("broker_run")
      .select("run_id,status,started_at,completed_at,updated_at,created_at,error,terminal_reason")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(limit),
  );

  return rows as BrokerRunObservationRow[];
}

async function getRecentTasks(runIds: string[], limit: number) {
  if (runIds.length === 0) return [];

  const rows = await executeSupabaseRows<BrokerTaskObservationRow>(
    "broker_task query",
    getServiceRoleSupabase()
      .from("broker_task")
      .select("task_id,run_id,status,type,last_event,last_event_at,error,updated_at")
      .in("run_id", runIds)
      .order("updated_at", { ascending: false })
      .limit(limit),
  );

  return rows as BrokerTaskObservationRow[];
}

async function assertObservationPolicy(input: {
  accessToken: string;
  userId: string;
  targetAgentId: string;
  observerAgentId?: string | null;
}) {
  const targetAgent = await findSetupAgentById(input.accessToken, input.targetAgentId);
  if (!targetAgent) {
    throw new ApiRouteError(404, "agent_not_found", "Target agent was not found");
  }

  if (!targetAgent.workspace_id) {
    throw new ApiRouteError(409, "agent_workspace_missing", "Target agent is not assigned to a workspace");
  }

  try {
    await assertWorkspaceMembership(input.userId, targetAgent.workspace_id);
  } catch (error) {
    if (!isWorkspaceAuthorizationMiss(error)) {
      throw new ApiRouteError(
        502,
        "workspace_membership_check_failed",
        "Could not verify workspace membership",
        String(error),
      );
    }

    throw new ApiRouteError(
      403,
      "workspace_forbidden",
      "User is not authorized for the target workspace",
      String(error),
    );
  }

  const observerAgentId = input.observerAgentId?.trim() || null;
  if (!observerAgentId) return { targetAgent, observerAgent: null };

  const observerAgent = await findSetupAgentById(input.accessToken, observerAgentId);
  if (!observerAgent) {
    throw new ApiRouteError(404, "observer_agent_not_found", "Observer agent was not found");
  }

  if (observerAgent.workspace_id !== targetAgent.workspace_id) {
    throw new ApiRouteError(403, "agent_observation_forbidden", "Observer and target agents must share a workspace");
  }

  if (normalizeAgentType(observerAgent.type) !== "planning") {
    throw new ApiRouteError(403, "agent_observation_forbidden", "Only planning agents can observe other agents");
  }

  return { targetAgent, observerAgent };
}

function buildHealth(input: {
  config: GatewayConfigObservationRow | null;
  engine: EngineInstanceObservationRow | null;
  launcherReachable: boolean;
  launcherStatus: string | null;
  launcherError: string | null;
  latestRun: BrokerRunObservationRow | null;
  lastFailure: AgentObservationEvent | null;
}) {
  const configError = input.config?.last_apply_error ?? input.config?.sync_error ?? null;
  const runtimeStatus = input.engine?.status ?? null;
  const runFailed = Boolean(input.latestRun?.error || input.latestRun?.terminal_reason || input.lastFailure);
  const status =
    !input.launcherReachable && !input.engine
      ? "unavailable"
      : configError || runFailed
        ? "degraded"
        : runtimeStatus === "running" || input.launcherReachable
          ? "healthy"
          : "unknown";

  return {
    status,
    config: {
      status: input.config?.last_apply_status ?? input.config?.sync_status ?? null,
      error: configError,
      checkedAt: latestTimestamp(input.config?.last_apply_at, input.config?.synced_at),
    },
    runtime: {
      status: runtimeStatus,
      lastHeartbeatAt: input.engine?.last_health_at ?? null,
      instanceId: input.engine?.instance_id ?? null,
    },
    launcher: {
      reachable: input.launcherReachable,
      status: input.launcherStatus,
      error: input.launcherError,
    },
    latestRun: input.latestRun
      ? {
          runId: input.latestRun.run_id,
          status: input.latestRun.status,
          startedAt: input.latestRun.started_at,
          completedAt: input.latestRun.completed_at,
          updatedAt: input.latestRun.updated_at,
          error: input.latestRun.error,
          terminalReason: input.latestRun.terminal_reason,
        }
      : null,
    lastFailure: input.lastFailure,
  };
}

export async function observeAgent(input: ObservationInput): Promise<AgentObservationResponse> {
  const limit = clampLimit(input.limit);
  const { targetAgent } = await assertObservationPolicy(input);

  const [engine, config, runs, launcherResult] = await Promise.all([
    getLatestEngineInstance(input.targetAgentId),
    getGatewayConfig(input.targetAgentId, targetAgent.workspace_id),
    getRecentRuns(input.targetAgentId, limit),
    input.launcherClient
      .getAgent(input.targetAgentId)
      .then((result) => ({ ok: true as const, status: result.data.status, error: null }))
      .catch((error) => ({
        ok: false as const,
        status: null,
        error: error instanceof Error ? error.message : "launcher request failed",
      })),
  ]);

  const tasks = await getRecentTasks(
    runs.map((run) => run.run_id),
    limit,
  );

  const events = [summarizeConfig(config), ...runs.map(summarizeRun), ...tasks.map(summarizeTask)]
    .filter((event): event is AgentObservationEvent => Boolean(event))
    .sort((a, b) => new Date(b.occurredAt ?? 0).getTime() - new Date(a.occurredAt ?? 0).getTime())
    .slice(0, limit);

  const lastFailure = events.find((event) => event.severity === "error") ?? null;
  return AgentObservationResponseSchema.parse({
    observerAgentId: input.observerAgentId?.trim() || null,
    targetAgent: {
      id: targetAgent.id,
      name: targetAgent.name,
      workspaceId: targetAgent.workspace_id,
      agentType: normalizeAgentType(targetAgent.type),
    },
    health: buildHealth({
      config,
      engine,
      launcherReachable: launcherResult.ok,
      launcherStatus: launcherResult.status,
      launcherError: launcherResult.error,
      latestRun: runs[0] ?? null,
      lastFailure,
    }),
    events,
  });
}
