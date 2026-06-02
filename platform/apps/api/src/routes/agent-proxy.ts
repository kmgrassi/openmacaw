import type { Express, Request, Response } from "express";

import { proxyResolvedRuntimeRequest } from "../services/agent-proxy-transport.js";
import type { UpstreamResponse } from "../services/upstream.js";

export function registerAgentProxyRoutes(
  app: Express,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
  requestTimeoutMs: number,
) {
  app.all("/api/agents", async (req: Request, res: Response) => {
    return await proxyResolvedRuntimeRequest({
      req,
      res,
      launcherRequest,
      requestTimeoutMs,
    });
  });

  app.all("/api/agents/refresh", async (req: Request, res: Response) => {
    return await proxyResolvedRuntimeRequest({
      req,
      res,
      launcherRequest,
      requestTimeoutMs,
    });
  });

  app.all("/api/agents/:identifier*", async (req: Request, res: Response) => {
    return await proxyResolvedRuntimeRequest({
      req,
      res,
      launcherRequest,
      requestTimeoutMs,
    });
  });
}
