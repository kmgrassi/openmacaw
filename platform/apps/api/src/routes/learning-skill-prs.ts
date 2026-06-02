import type { Express } from "express";

import { SkillCandidatePrCreateRequestSchema } from "../../../../contracts/learning-skill-prs.js";
import type { ApiConfig } from "../config.js";
import { ApiRouteError, apiRoute } from "../http.js";
import { openSkillCandidatePullRequest } from "../services/learning/skill-candidate-pr-bot.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

async function requireWorkspaceAccess(userId: string, workspaceId: string) {
  try {
    await assertWorkspaceMembership(userId, workspaceId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not authorized")) {
      throw new ApiRouteError(
        403,
        "workspace_forbidden",
        "Authenticated user is not authorized for the requested workspace",
      );
    }
    throw error;
  }
}

function routeWorkspaceId(value: string | undefined) {
  const workspaceId = value?.trim() ?? "";
  if (!workspaceId) {
    throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
  }
  return workspaceId;
}

export function registerLearningSkillPrRoutes(app: Express, config: ApiConfig) {
  app.post(
    "/api/workspaces/:workspaceId/learning/skill-candidate-prs",
    apiRoute({
      requireAuth: true,
      bodySchema: SkillCandidatePrCreateRequestSchema,
      invalidBodyMessage: "Invalid skill candidate PR request",
      async handler({ req, res, userId, body }) {
        const workspaceId = routeWorkspaceId(req.params.workspaceId);
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        const response = await openSkillCandidatePullRequest({
          workspaceId,
          request: body,
          config: {
            githubApiToken: config.githubApiToken ?? null,
            githubRepoWorkspaceMap: config.githubRepoWorkspaceMap,
          },
        });
        return res.status(201).json(response);
      },
    }),
  );
}
