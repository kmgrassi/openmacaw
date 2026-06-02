import type { Express } from "express";
import { z } from "zod";

import { apiRoute, requireRouteParam } from "../http.js";
import { reflectRunToMemories } from "../services/learning/reflector.js";
import { requireServiceRoleBearer } from "../services/service-role-auth.js";

const LearningReflectionJobRequestSchema = z.object({
  sourceTaskId: z.string().trim().min(1).nullable().optional(),
});

export function registerLearningRoutes(app: Express) {
  app.post(
    "/api/learning/jobs/:sourceRunId/reflection",
    apiRoute({
      bodySchema: LearningReflectionJobRequestSchema,
      invalidBodyMessage: "Learning reflection job request is invalid",
      handler: async ({ req, res, body }) => {
        requireServiceRoleBearer(req);
        const sourceRunId = requireRouteParam(req, "sourceRunId", "sourceRunId is required");
        const result = await reflectRunToMemories({
          sourceRunId,
          sourceTaskId: body.sourceTaskId ?? null,
        });
        return res.status(202).json({ reflection: result });
      },
    }),
  );
}
