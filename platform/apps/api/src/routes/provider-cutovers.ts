import type { Express } from "express";
import { z } from "zod";

import {
  CreateProviderCutoverRequestSchema,
  ProviderCutoverListResponseSchema,
  ProviderCutoverRecentResponseSchema,
  ProviderCutoverSchema,
} from "../../../../contracts/provider-cutover.js";
import { ApiRouteError, apiRoute } from "../http.js";
import {
  create,
  getWorkspaceIdForWorkItem,
  listForWorkItem,
  listRecentForWorkspace,
} from "../repositories/provider-cutovers.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { requireServiceRoleBearer } from "../services/service-role-auth.js";

const RecentCutoversQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z
    .string()
    .regex(/^.+\|.+$/)
    .optional(),
});

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

async function requireWorkItemWorkspaceAccess(userId: string, workItemId: string) {
  const workspaceId = await getWorkspaceIdForWorkItem(workItemId);
  if (!workspaceId) {
    throw new ApiRouteError(404, "work_item_not_found", "Work item was not found");
  }

  await requireWorkspaceAccess(userId, workspaceId);
  return workspaceId;
}

export function registerProviderCutoverRoutes(app: Express) {
  app.post(
    "/api/work-items/:id/cutovers",
    apiRoute({
      bodySchema: CreateProviderCutoverRequestSchema,
      invalidBodyMessage: "Invalid provider cutover audit payload",
      async handler({ req, res, body }) {
        requireServiceRoleBearer(req);
        const workItemId = req.params.id?.trim() ?? "";
        if (!workItemId) {
          throw new ApiRouteError(400, "invalid_request", "work item id is required");
        }

        const workspaceId = await getWorkspaceIdForWorkItem(workItemId);
        if (!workspaceId) {
          throw new ApiRouteError(404, "work_item_not_found", "Work item was not found");
        }

        const cutover = await create({ workItemId, workspaceId, cutover: body });
        return res.status(201).json(ProviderCutoverSchema.parse(cutover));
      },
    }),
  );

  app.get(
    "/api/work-items/:id/cutovers",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workItemId = req.params.id?.trim() ?? "";
        if (!workItemId) {
          throw new ApiRouteError(400, "invalid_request", "work item id is required");
        }

        await requireWorkItemWorkspaceAccess(userId, workItemId);
        return res
          .status(200)
          .json(ProviderCutoverListResponseSchema.parse({ items: await listForWorkItem(workItemId) }));
      },
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/cutovers/recent",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = req.params.workspaceId?.trim() ?? "";
        if (!workspaceId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        }

        const parsedQuery = RecentCutoversQuerySchema.safeParse(req.query);
        if (!parsedQuery.success) {
          throw new ApiRouteError(400, "invalid_request", "Invalid recent cutovers query", parsedQuery.error.flatten());
        }

        await requireWorkspaceAccess(userId, workspaceId);
        return res
          .status(200)
          .json(
            ProviderCutoverRecentResponseSchema.parse(
              await listRecentForWorkspace(workspaceId, parsedQuery.data.limit, parsedQuery.data.cursor),
            ),
          );
      },
    }),
  );
}
