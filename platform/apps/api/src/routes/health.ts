import type { Express, Request, Response } from "express";

import type { ApiConfig } from "../config.js";
import { errorPayload, handleProxyError, mapLauncherError } from "../http.js";
import type { LauncherClient } from "../services/launcher.js";
import { requestAgentId, resolveRuntimeTargetForAgent } from "../services/runtime-target.js";
import { createUpstreamRequester, type UpstreamResponse } from "../services/upstream.js";

async function buildHealthPayload(
  req: Request,
  config: ApiConfig,
  launcherClient: LauncherClient,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
) {
  const launcherResult = await launcherClient.getHealth().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

  const launcherHealth = launcherResult.ok ? launcherResult.value : mapLauncherError(launcherResult.error).body;
  const launcherOk = launcherResult.ok && launcherResult.value.ok;

  const agentId = requestAgentId(req);
  if (!agentId) {
    return {
      status: launcherOk ? 200 : 503,
      body: {
        ok: launcherOk,
        service: "symphony-express-server",
        launcherBaseUrl: config.launcherBaseUrl,
        launcherHealth: launcherHealth,
        runtimeTarget: null,
        orchestratorHealth: errorPayload(
          "runtime_unscoped",
          "No agentId was provided, so runtime health was not checked",
        ),
      },
    };
  }

  let target = await resolveRuntimeTargetForAgent(agentId, launcherRequest);
  let runtimeRequest = createUpstreamRequester(target.baseUrl, config.orchestratorRequestTimeoutMs);
  let orchestratorHealth: UpstreamResponse;

  try {
    orchestratorHealth = await runtimeRequest("/api/v1/health", { method: "GET" });
  } catch {
    await launcherRequest(`/agents/${encodeURIComponent(agentId)}`, { method: "GET" }).catch(() => undefined);
    target = await resolveRuntimeTargetForAgent(agentId, launcherRequest);
    runtimeRequest = createUpstreamRequester(target.baseUrl, config.orchestratorRequestTimeoutMs);
    orchestratorHealth = await runtimeRequest("/api/v1/health", { method: "GET" });
  }

  const orchestratorOk =
    orchestratorHealth.status >= 200 &&
    orchestratorHealth.status < 300 &&
    Boolean((orchestratorHealth.body as { ok?: boolean })?.ok);

  return {
    status: launcherOk && orchestratorOk ? 200 : 503,
    body: {
      ok: launcherOk && orchestratorOk,
      service: "symphony-express-server",
      launcherBaseUrl: config.launcherBaseUrl,
      launcherHealth: launcherHealth,
      runtimeTarget: {
        agentId: target.agentId,
        host: target.host,
        port: target.port,
        instanceId: target.instanceId,
      },
      orchestratorHealth: orchestratorHealth.body,
    },
  };
}

export function registerHealthRoutes(
  app: Express,
  config: ApiConfig,
  launcherClient: LauncherClient,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
) {
  app.get("/health", async (req: Request, res: Response) => {
    try {
      const payload = await buildHealthPayload(req, config, launcherClient, launcherRequest);
      return res.status(payload.status).json(payload.body);
    } catch (error) {
      return handleProxyError(res, error);
    }
  });

  app.get("/livez", (_req: Request, res: Response) => {
    return res.status(200).json({
      ok: true,
      service: "symphony-express-server",
    });
  });

  app.get("/api/v1/health", async (req: Request, res: Response) => {
    try {
      const payload = await buildHealthPayload(req, config, launcherClient, launcherRequest);
      return res.status(payload.status).json(payload.body);
    } catch (error) {
      return handleProxyError(res, error);
    }
  });
}
