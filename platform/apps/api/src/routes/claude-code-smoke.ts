import type { Express, Request, Response } from "express";

import { ClaudeCodeSmokeResponseSchema } from "../../../../contracts/claude-code-smoke.js";
import { buildClaudeCodeDispatchSmokeHarness } from "../services/claude-code-smoke.js";

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function registerClaudeCodeSmokeRoutes(app: Express) {
  app.get("/api/smoke/claude-code-dispatch", (req: Request, res: Response) => {
    const payload = buildClaudeCodeDispatchSmokeHarness({
      model: queryValue(req.query.model),
    });

    return res.status(200).json(ClaudeCodeSmokeResponseSchema.parse(payload));
  });
}
