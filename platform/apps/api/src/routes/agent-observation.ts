import type { Express, Request, Response } from "express";

import { AgentObservationResponseSchema } from "../../../../contracts/agents.js";
import {
  ApiRouteError,
  errorPayload,
  handleApiRouteError,
  requireAccessToken,
  requireRouteParam,
  requireVerifiedUser,
} from "../http.js";
import { observeAgent } from "../services/agent-observation.js";
import type { LauncherClient } from "../services/launcher.js";

function requestLimit(req: Request) {
  const raw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  return Number.isFinite(raw ?? NaN) ? raw : undefined;
}

function observerAgentId(req: Request) {
  const queryValue = typeof req.query.observerAgentId === "string" ? req.query.observerAgentId.trim() : "";
  const bodyValue = typeof req.body?.observerAgentId === "string" ? req.body.observerAgentId.trim() : "";
  return bodyValue || queryValue || null;
}

async function handleObserve(req: Request, res: Response, launcherClient: LauncherClient) {
  try {
    const observation = await observeAgent({
      accessToken: requireAccessToken(req),
      userId: requireVerifiedUser(req),
      targetAgentId: requireRouteParam(req, "agentId"),
      observerAgentId: observerAgentId(req),
      limit: requestLimit(req),
      launcherClient,
    });

    return res.status(200).json(AgentObservationResponseSchema.parse(observation));
  } catch (error) {
    if (error instanceof ApiRouteError) {
      return handleApiRouteError(res, error, {
        status: 500,
        code: "agent_observation_failed",
        message: "Could not observe agent",
      });
    }

    return res.status(502).json(errorPayload("agent_observation_failed", "Could not observe agent", String(error)));
  }
}

export function registerAgentObservationRoutes(app: Express, launcherClient: LauncherClient) {
  app.get("/api/agents/:agentId/observe", async (req: Request, res: Response) => {
    return handleObserve(req, res, launcherClient);
  });

  app.post("/api/agents/:agentId/observe", async (req: Request, res: Response) => {
    return handleObserve(req, res, launcherClient);
  });
}
