import type { Express } from "express";

import { MemoryItemListQuerySchema } from "../../../../contracts/memory-items.js";
import { ApiRouteError, apiRoute, handleApiRouteError } from "../http.js";
import { listMemoryItemsForWorkspace } from "../repositories/memory-items.js";
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

export function registerMemoryItemRoutes(app: Express) {
  app.get(
    "/api/workspaces/:workspaceId/memory-items",
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

        const parsed = MemoryItemListQuerySchema.safeParse({
          agentId:
            typeof req.query.agentId === "string"
              ? req.query.agentId.trim() === ""
                ? null
                : req.query.agentId
              : undefined,
          scope: typeof req.query.scope === "string" ? req.query.scope : undefined,
          importanceMin: typeof req.query.importanceMin === "string" ? req.query.importanceMin : undefined,
          sourceRunId: typeof req.query.sourceRunId === "string" ? req.query.sourceRunId : undefined,
          limit: typeof req.query.limit === "string" ? req.query.limit : undefined,
        });
        if (!parsed.success) {
          throw new ApiRouteError(400, "invalid_request", "Invalid memory item query", parsed.error.flatten());
        }

        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await listMemoryItemsForWorkspace(workspaceId, parsed.data));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "memory_items_read_failed",
          message: "Could not read memory items",
        }),
    }),
  );
}
