import type { Express } from "express";

import {
  WorkspaceSettingsPatchSchema,
  WorkspaceSettingsResponseSchema,
} from "../../../../contracts/workspace-settings.js";
import { ApiRouteError, apiRoute } from "../http.js";
import { patchWorkspaceSettings, readWorkspaceSettings } from "../services/workspace-settings.js";
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

export function registerWorkspaceSettingsRoutes(app: Express) {
  app.get(
    "/api/workspaces/:workspaceId/settings",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = routeWorkspaceId(req.params.workspaceId);
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        const settings = await readWorkspaceSettings(workspaceId);
        return res.status(200).json(WorkspaceSettingsResponseSchema.parse({ settings }));
      },
    }),
  );

  app.patch(
    ["/api/workspaces/:workspaceId/settings", "/api/workspaces/:workspaceId/settings/tracker"],
    apiRoute({
      requireAuth: true,
      bodySchema: WorkspaceSettingsPatchSchema,
      invalidBodyMessage: "Invalid workspace settings patch",
      async handler({ req, res, userId, body }) {
        const workspaceId = routeWorkspaceId(req.params.workspaceId);
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        const settings = await patchWorkspaceSettings({
          workspaceId,
          userId: userId ?? null,
          patch: body,
        });
        return res.status(200).json(WorkspaceSettingsResponseSchema.parse({ settings }));
      },
    }),
  );
}
