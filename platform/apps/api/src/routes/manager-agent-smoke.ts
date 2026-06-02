import type { Express, Request, Response } from "express";

import { ManagerAgentSmokeResponseSchema } from "../../../../contracts/manager-agent-smoke.js";
import { buildManagerAgentSmokeHarness } from "../services/manager-agent-smoke.js";

export function registerManagerAgentSmokeRoutes(app: Express) {
  app.get("/api/smoke/manager-agent", (_req: Request, res: Response) => {
    return res.status(200).json(ManagerAgentSmokeResponseSchema.parse(buildManagerAgentSmokeHarness()));
  });
}
