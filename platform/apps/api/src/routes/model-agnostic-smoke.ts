import type { Express, Request, Response } from "express";

import { ModelAgnosticSmokeResponseSchema } from "../../../../contracts/model-agnostic-smoke.js";
import { buildModelAgnosticSmokeHarness } from "../services/model-agnostic-smoke.js";

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function registerModelAgnosticSmokeRoutes(app: Express) {
  app.get("/api/smoke/model-agnostic-handoff", (req: Request, res: Response) => {
    const payload = buildModelAgnosticSmokeHarness({
      planningProvider: queryValue(req.query.planningProvider),
      planningModel: queryValue(req.query.planningModel),
      codingProvider: queryValue(req.query.codingProvider),
      codingModel: queryValue(req.query.codingModel),
    });

    return res.status(200).json(ModelAgnosticSmokeResponseSchema.parse(payload));
  });
}
