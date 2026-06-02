import type { Express, Request, Response } from "express";

import { LocalModelCodingSmokeResponseSchema } from "../../../../contracts/local-model-coding-smoke.js";
import { buildLocalModelCodingSmokeHarness } from "../services/local-model-coding-smoke.js";

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function registerLocalModelCodingSmokeRoutes(app: Express) {
  app.get("/api/smoke/local-model-coding-runner", (req: Request, res: Response) => {
    const payload = buildLocalModelCodingSmokeHarness({
      model: queryValue(req.query.model),
      approvalPolicy: queryValue(req.query.approvalPolicy),
    });

    return res.status(200).json(LocalModelCodingSmokeResponseSchema.parse(payload));
  });
}
