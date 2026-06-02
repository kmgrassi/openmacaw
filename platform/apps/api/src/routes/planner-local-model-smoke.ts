import type { Express, Request, Response } from "express";

import { PlannerLocalModelSmokeResponseSchema } from "../../../../contracts/planner-local-model-smoke.js";
import { buildPlannerLocalModelSmokeHarness } from "../services/planner-local-model-smoke.js";

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function registerPlannerLocalModelSmokeRoutes(app: Express) {
  app.get("/api/smoke/planner-local-model", (req: Request, res: Response) => {
    const payload = buildPlannerLocalModelSmokeHarness({
      model: queryValue(req.query.model),
      observedMs: queryValue(req.query.observedMs),
    });

    return res.status(200).json(PlannerLocalModelSmokeResponseSchema.parse(payload));
  });
}
