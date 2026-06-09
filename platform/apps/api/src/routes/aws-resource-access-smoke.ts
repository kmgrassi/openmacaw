import type { Express, Request, Response } from "express";

import { AwsResourceAccessSmokeResponseSchema } from "../../../../contracts/aws-resource-access-smoke.js";
import { buildAwsResourceAccessSmokeHarness } from "../services/aws-resource-access-smoke.js";

export function registerAwsResourceAccessSmokeRoutes(app: Express) {
  app.get("/api/smoke/container-execution-e1-handoff", (_req: Request, res: Response) => {
    const payload = buildAwsResourceAccessSmokeHarness();

    return res.status(200).json(AwsResourceAccessSmokeResponseSchema.parse(payload));
  });
}
