import type { Express } from "express";
import { z } from "zod";

import { LearningCostResponseSchema } from "../../../../contracts/learning-cost.js";
import { ApiRouteError, apiRoute } from "../http.js";
import { getLearningCost } from "../services/learning-cost.js";

const DateQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function dateRangeFromQuery(query: Record<string, unknown>) {
  const fallback = defaultDateRange();
  const parsed = DateQuerySchema.safeParse({
    startDate: typeof query.startDate === "string" ? query.startDate : fallback.startDate,
    endDate: typeof query.endDate === "string" ? query.endDate : fallback.endDate,
  });
  if (!parsed.success) {
    throw new ApiRouteError(
      400,
      "invalid_request",
      "startDate and endDate must use YYYY-MM-DD",
      parsed.error.flatten(),
    );
  }
  if (parsed.data.startDate > parsed.data.endDate) {
    throw new ApiRouteError(400, "invalid_request", "startDate must be on or before endDate");
  }
  return parsed.data;
}

export function registerLearningCostRoutes(app: Express) {
  app.get(
    "/api/workspaces/:workspaceId/learning-cost",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = req.params.workspaceId?.trim() ?? "";
        if (!workspaceId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        }
        if (!userId) {
          throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
        }

        const dateRange = dateRangeFromQuery(req.query);
        const response = await getLearningCost({
          userId,
          workspaceId,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
        });
        return res.status(200).json(LearningCostResponseSchema.parse(response));
      },
    }),
  );
}
