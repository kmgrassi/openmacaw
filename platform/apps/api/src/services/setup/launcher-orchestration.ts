import { randomUUID } from "node:crypto";

import { ApiRouteError } from "../../http.js";
import { getUserScopedSupabase, normalizeSupabaseError } from "../../supabase-client.js";
import {
  LauncherHttpError,
  LauncherNetworkError,
  LauncherResponseParseError,
  LauncherTimeoutError,
  type LauncherClient,
} from "../launcher.js";
import { resolveRuntimeTargetForAgent } from "../runtime-target.js";
import type { UpstreamResponse } from "../upstream.js";
import { getLatestEngine } from "./store.js";
import type { AgentRow } from "./types.js";

const ENGINE_POLL_INTERVAL_MS = 1_000;
const ENGINE_POLL_TIMEOUT_MS = 30_000;
const ENGINE_INSTANCE_SELECT =
  "instance_id,agent_id,workspace_id,host,port,role,status,started_at,last_health_at,updated_at,ws_connection_id" as const;

export type LauncherRequest = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEngineRunningStatus(status: string | null | undefined) {
  return status === "running" || status === "healthy";
}

function isEngineFailedStatus(status: string | null | undefined) {
  return status === "failed" || status === "unhealthy";
}

export async function getLiveRuntimeHealth(agentId: string, launcherRequest?: LauncherRequest) {
  if (!launcherRequest) return null;

  const checkedAt = new Date().toISOString();

  try {
    const target = await resolveRuntimeTargetForAgent(agentId, launcherRequest);

    return {
      ok: true,
      source: target.instanceId === "launcher-runtime" ? "launcher" : "engine_instance",
      status: "healthy",
      checkedAt,
      runtimeTarget: {
        agentId: target.agentId,
        host: target.host,
        port: target.port,
        instanceId: target.instanceId,
      },
      errorCode: null,
      errorMessage: null,
    } as const;
  } catch (error) {
    return {
      ok: false,
      source: "launcher",
      status: "unavailable",
      checkedAt,
      runtimeTarget: null,
      errorCode:
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "runtime_health_unavailable",
      errorMessage: error instanceof Error ? error.message : "Runtime health is unavailable",
    } as const;
  }
}

export async function waitForEngineRunning(accessToken: string, agentId: string, launcherRequest?: LauncherRequest) {
  const deadline = Date.now() + ENGINE_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const engine = await getLatestEngine(accessToken, agentId);
    if (isEngineRunningStatus(engine?.status)) {
      return engine;
    }
    if (isEngineFailedStatus(engine?.status)) {
      throw new ApiRouteError(502, "engine_start_failed", "Launcher reported a failed engine start", engine);
    }
    const runtimeHealth = await getLiveRuntimeHealth(agentId, launcherRequest);
    if (runtimeHealth?.ok) {
      return engine;
    }
    await sleep(ENGINE_POLL_INTERVAL_MS);
  }

  throw new ApiRouteError(504, "engine_start_timeout", "Timed out waiting for the orchestrator to report running");
}

async function markEngineFailed(accessToken: string, agent: AgentRow, reason: string) {
  const now = new Date().toISOString();
  const latestEngine = await getLatestEngine(accessToken, agent.id);

  if (latestEngine) {
    const { data, error } = await getUserScopedSupabase(accessToken)
      .from("engine_instance")
      .update({
        status: "unhealthy",
        last_health_at: now,
      })
      .eq("instance_id", latestEngine.instance_id)
      .select(ENGINE_INSTANCE_SELECT);

    if (error) throw normalizeSupabaseError("engine_instance update", error);
    return data[0] ?? latestEngine;
  }

  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("engine_instance")
    .insert({
      instance_id: randomUUID(),
      agent_id: agent.id,
      workspace_id: agent.workspace_id,
      host: "launcher-unreachable",
      port: 0,
      role: "unified",
      status: "unhealthy",
      started_at: now,
      last_health_at: now,
      ws_connection_id: reason,
    })
    .select(ENGINE_INSTANCE_SELECT);

  if (error) throw normalizeSupabaseError("engine_instance insert", error);
  return data[0] ?? null;
}

export async function ensureLauncherStarted(launcherClient: LauncherClient, agent: AgentRow, accessToken: string) {
  void accessToken;
  try {
    const launcherResponse = await launcherClient.startAgent(agent.id);

    if (launcherResponse.status >= 400 && launcherResponse.status < 500) {
      throw new ApiRouteError(
        400,
        "launcher_invalid_request",
        "Launcher rejected the setup request",
        launcherResponse.data,
      );
    }

    if (launcherResponse.status >= 500) {
      await markEngineFailed(accessToken, agent, "launcher_5xx");
      throw new ApiRouteError(
        502,
        "launcher_unreachable",
        "Launcher failed while starting the orchestrator",
        launcherResponse.data,
      );
    }
  } catch (error) {
    if (error instanceof ApiRouteError) {
      throw error;
    }

    if (
      error instanceof LauncherHttpError ||
      error instanceof LauncherNetworkError ||
      error instanceof LauncherTimeoutError ||
      error instanceof LauncherResponseParseError
    ) {
      await markEngineFailed(accessToken, agent, "launcher_unreachable");

      if (error instanceof LauncherHttpError && error.status >= 400 && error.status < 500) {
        throw new ApiRouteError(400, "launcher_invalid_request", "Launcher rejected the setup request", error.body);
      }

      throw new ApiRouteError(
        502,
        "launcher_unreachable",
        "Could not reach the launcher",
        error instanceof LauncherHttpError ? error.body : error.message,
      );
    }

    await markEngineFailed(accessToken, agent, "launcher_unreachable");
    throw new ApiRouteError(
      502,
      "launcher_unreachable",
      "Could not reach the launcher",
      error instanceof Error ? error.message : error,
    );
  }
}
