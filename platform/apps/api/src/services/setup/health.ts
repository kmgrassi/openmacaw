import type {
  AgentHealthFailure,
  AgentHealthLayer,
  AgentHealthResponse,
  AgentHealthStatus,
} from "../../../../../contracts/agent-health.js";
import { ApiRouteError } from "../../http.js";
import { findSetupAgentById } from "../../repositories/agents.js";
import { getUserScopedSupabase, normalizeSupabaseError } from "../../supabase-client.js";
import type { LauncherClient } from "../launcher.js";
import { buildRequirementStatus } from "./builders.js";
import { getAgentCredentialCount, getGatewayConfig, getGatewayConfigState, getLatestEngine } from "./store.js";
import type { BrokerRunRow, BrokerTaskRow } from "./types.js";

const BROKER_RUN_SELECT = "run_id,agent_id,status,error,terminal_reason,updated_at,completed_at" as const;
const BROKER_TASK_SELECT = "task_id,run_id,status,type,error,last_event,last_event_at,updated_at" as const;

function healthFailure(input: {
  sourceLayer: AgentHealthLayer;
  code: string;
  message: string | null | undefined;
  occurredAt?: string | null;
  retryable?: boolean | null;
}): AgentHealthFailure {
  return {
    sourceLayer: input.sourceLayer,
    code: input.code,
    message: input.message?.trim() || input.code,
    occurredAt: input.occurredAt ?? null,
    retryable: input.retryable ?? null,
  };
}

function newerFailure(left: AgentHealthFailure | null, right: AgentHealthFailure | null) {
  if (!left) return right;
  if (!right) return left;
  if (!left.occurredAt) return right;
  if (!right.occurredAt) return left;
  return new Date(right.occurredAt).getTime() >= new Date(left.occurredAt).getTime() ? right : left;
}

function classifyTaskLayer(task: BrokerTaskRow): AgentHealthLayer {
  const value = `${task.type} ${task.last_event ?? ""}`.toLowerCase();
  if (value.includes("model") || value.includes("llm") || value.includes("provider")) return "model";
  if (value.includes("tool")) return "tool";
  return "runtime";
}

function isFailureRunStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase();
  return normalized === "failed" || normalized === "error" || normalized === "timed_out";
}

function isFailureTerminalReason(reason: string | null | undefined) {
  const normalized = reason?.trim().toLowerCase();
  if (!normalized) return false;
  if (
    [
      "cancelled",
      "canceled",
      "user_cancelled",
      "user_canceled",
      "completed",
      "complete",
      "done",
      "success",
      "stopped",
      "stopped_by_user",
      "user_stopped",
    ].includes(normalized)
  ) {
    return false;
  }

  return ["fail", "error", "timeout", "orphan", "unhealthy", "crash", "exception", "rejected"].some((token) =>
    normalized.includes(token),
  );
}

function classifyOverallHealth(input: {
  requirements: { configured: boolean };
  launcherReachable: boolean;
  databaseFailure: AgentHealthFailure | null;
  engineStatus: string | null | undefined;
  lastFailure: AgentHealthFailure | null;
}): AgentHealthStatus {
  if (!input.requirements.configured || input.engineStatus === "failed" || input.engineStatus === "unhealthy") {
    return "unhealthy";
  }
  if (!input.launcherReachable || input.databaseFailure || input.lastFailure) {
    return "degraded";
  }
  if (input.engineStatus === "running" || input.engineStatus === "healthy") {
    return "healthy";
  }
  return input.engineStatus ? "degraded" : "unknown";
}

async function getLatestBrokerRun(accessToken: string, agentId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("broker_run")
    .select(BROKER_RUN_SELECT)
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw normalizeSupabaseError("broker_run query", error);
  return (data[0] as BrokerRunRow | undefined) ?? null;
}

async function getLatestFailedBrokerTask(accessToken: string, runId: string | null | undefined) {
  if (!runId) return null;

  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("broker_task")
    .select(BROKER_TASK_SELECT)
    .eq("run_id", runId)
    .not("error", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) throw normalizeSupabaseError("broker_task query", error);
  return (data[0] as BrokerTaskRow | undefined) ?? null;
}

export async function getAgentHealth(
  accessToken: string,
  verifiedUserId: string,
  agentId: string,
  launcherClient: LauncherClient,
): Promise<AgentHealthResponse> {
  const requesterUserId = verifiedUserId.trim();

  const agent = await findSetupAgentById(accessToken, agentId);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  const [gatewayConfig, gatewayConfigState, engine, credentialCount, latestRun] = await Promise.all([
    getGatewayConfig(accessToken, agentId),
    getGatewayConfigState(accessToken, agentId),
    getLatestEngine(accessToken, agentId),
    getAgentCredentialCount(accessToken, requesterUserId, agent),
    getLatestBrokerRun(accessToken, agentId),
  ]);
  const latestFailedTask = await getLatestFailedBrokerTask(accessToken, latestRun?.run_id);
  const requirements = buildRequirementStatus(agent, gatewayConfig, credentialCount);

  const configError =
    gatewayConfigState?.last_apply_error || gatewayConfigState?.sync_error
      ? healthFailure({
          sourceLayer: "gateway",
          code: gatewayConfigState.last_apply_error ? "gateway_apply_failed" : "gateway_sync_failed",
          message: gatewayConfigState.last_apply_error ?? gatewayConfigState.sync_error,
          occurredAt: gatewayConfigState.last_apply_at ?? gatewayConfigState.synced_at,
          retryable: true,
        })
      : !requirements.configured
        ? healthFailure({
            sourceLayer: "config",
            code: "agent_configuration_incomplete",
            message: `Missing ${requirements.missing.join(", ")}`,
            occurredAt: agent.updated_at,
            retryable: false,
          })
        : null;

  let launcherReachable = false;
  let launcherStatus = "unreachable";
  let launcherService: string | null = null;
  let launcherError: AgentHealthFailure | null = null;
  let databaseHealth: {
    configured: boolean | null;
    started: boolean | null;
    connected: boolean | null;
    status: string;
    source: string | null;
    lastError: AgentHealthFailure | null;
  } = {
    configured: null,
    started: null,
    connected: null,
    status: "unknown",
    source: null,
    lastError: null,
  };
  try {
    const launcherHealth = await launcherClient.getHealth();
    launcherReachable = Boolean(launcherHealth.ok);
    launcherStatus = launcherHealth.ok ? "reachable" : "unhealthy";
    launcherService = launcherHealth.service;
    if (launcherHealth.database) {
      const db = launcherHealth.database;
      const dbError =
        db.configured && !db.connected
          ? healthFailure({
              sourceLayer: "database",
              code: db.status || "database_unavailable",
              message: db.last_error ?? `Database is ${db.status}`,
              occurredAt: new Date().toISOString(),
              retryable: true,
            })
          : null;

      databaseHealth = {
        configured: db.configured,
        started: db.started,
        connected: db.connected,
        status: db.status,
        source: db.source,
        lastError: dbError,
      };
    }
    if (!launcherHealth.ok) {
      launcherError = healthFailure({
        sourceLayer: "launcher",
        code: "launcher_unhealthy",
        message: "Launcher health check returned not ok",
        occurredAt: new Date().toISOString(),
        retryable: true,
      });
    }
  } catch (error) {
    launcherError = healthFailure({
      sourceLayer: "launcher",
      code: "launcher_unreachable",
      message: error instanceof Error ? error.message : "Could not reach launcher",
      occurredAt: new Date().toISOString(),
      retryable: true,
    });
  }

  const runtimeError =
    engine?.status === "failed" || engine?.status === "unhealthy"
      ? healthFailure({
          sourceLayer: "runtime",
          code: "runtime_unhealthy",
          message: `Runtime engine is ${engine.status}`,
          occurredAt: engine.last_health_at ?? engine.updated_at,
          retryable: true,
        })
      : null;

  const runFailureMessage =
    latestRun?.error ??
    (isFailureRunStatus(latestRun?.status) || isFailureTerminalReason(latestRun?.terminal_reason)
      ? (latestRun?.terminal_reason ?? latestRun?.status)
      : null);

  const runError =
    runFailureMessage && latestRun
      ? healthFailure({
          sourceLayer: "runtime",
          code: latestRun.error ? "run_failed" : "run_terminal",
          message: runFailureMessage,
          occurredAt: latestRun.completed_at ?? latestRun.updated_at,
          retryable: latestRun.status !== "completed",
        })
      : null;

  const taskError = latestFailedTask?.error
    ? healthFailure({
        sourceLayer: classifyTaskLayer(latestFailedTask),
        code: `${classifyTaskLayer(latestFailedTask)}_failed`,
        message: latestFailedTask.error,
        occurredAt: latestFailedTask.last_event_at ?? latestFailedTask.updated_at,
        retryable: true,
      })
    : null;

  const databaseError = databaseHealth.lastError;
  const lastFailure = [configError, launcherError, databaseError, runtimeError, runError, taskError].reduce(
    newerFailure,
    null,
  );
  const runtimeState = engine?.status ?? (launcherReachable ? "not_reported" : "unknown");

  return {
    agentId: agent.id,
    workspaceId: agent.workspace_id,
    checkedAt: new Date().toISOString(),
    status: classifyOverallHealth({
      requirements,
      launcherReachable,
      databaseFailure: databaseError,
      engineStatus: engine?.status,
      lastFailure,
    }),
    config: {
      configured: requirements.configured,
      missing: requirements.missing,
      gatewaySyncStatus: gatewayConfigState?.sync_status ?? null,
      gatewayApplyStatus: gatewayConfigState?.last_apply_status ?? null,
      lastError: configError,
    },
    launcher: {
      reachable: launcherReachable,
      status: launcherStatus,
      service: launcherService,
      lastError: launcherError,
    },
    database: databaseHealth,
    runtime: {
      state: runtimeState,
      engineStatus: engine?.status ?? null,
      instanceId: engine?.instance_id ?? null,
      lastHeartbeatAt: engine?.last_health_at ?? null,
      startedAt: engine?.started_at ?? null,
      lastError: runtimeError ?? runError ?? taskError,
    },
    lastFailure,
  };
}
