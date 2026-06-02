import type { Express } from "express";
import { z } from "zod";

import {
  ScheduledTaskCancelRequestSchema,
  ScheduledTaskCreateRequestSchema,
  ScheduledTaskUpdateRequestSchema,
} from "../../../../contracts/scheduled-tasks.js";
import { ApiRouteError, apiRoute, requestAccessToken } from "../http.js";
import {
  cancelScheduledTaskForWorkspace,
  createScheduledTaskForWorkspace,
  dispatchScheduledTaskForWorkspace,
  listScheduledTasksForWorkspace,
  runScheduledTaskNowForWorkspace,
  updateScheduledTaskForWorkspace,
} from "../services/scheduled-tasks.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

const ScheduledTaskDispatchRequestSchema = z.object({
  workspaceId: z.string().uuid(),
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

function routeWorkspaceId(value: string | undefined) {
  const workspaceId = value?.trim() ?? "";
  if (!workspaceId) {
    throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
  }
  return workspaceId;
}

function routeScheduledTaskId(value: string | undefined) {
  const scheduledTaskId = value?.trim() ?? "";
  if (!scheduledTaskId) {
    throw new ApiRouteError(400, "invalid_request", "scheduledTaskId is required");
  }
  return scheduledTaskId;
}

function routeOptionalAgentId(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiRouteError(400, "invalid_request", "agentId must be a string");
  }
  const agentId = value.trim();
  return agentId || undefined;
}

function requireServiceRoleBearer(req: Parameters<typeof requestAccessToken>[0]) {
  const bearer = requestAccessToken(req);
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!expected) {
    throw new ApiRouteError(
      500,
      "service_role_auth_unavailable",
      "SUPABASE_SERVICE_ROLE_KEY is required for internal scheduled-task delivery routes",
    );
  }
  if (bearer !== expected) {
    throw new ApiRouteError(401, "auth_required", "Service-role bearer token is required");
  }
}

export function registerScheduledTaskRoutes(app: Express) {
  app.get(
    "/api/workspaces/:workspaceId/scheduled-tasks",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = routeWorkspaceId(req.params.workspaceId);
        const agentId = routeOptionalAgentId(req.query.agentId);
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        return res.status(200).json(await listScheduledTasksForWorkspace(workspaceId, agentId));
      },
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/scheduled-tasks",
    apiRoute({
      requireAuth: true,
      bodySchema: ScheduledTaskCreateRequestSchema,
      invalidBodyMessage: "Invalid scheduled task create request",
      async handler({ req, res, userId, body }) {
        const workspaceId = routeWorkspaceId(req.params.workspaceId);
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        return res.status(201).json(
          await createScheduledTaskForWorkspace({
            workspaceId,
            userId: userId ?? "",
            request: body,
          }),
        );
      },
    }),
  );

  app.put(
    "/api/workspaces/:workspaceId/scheduled-tasks/:scheduledTaskId",
    apiRoute({
      requireAuth: true,
      bodySchema: ScheduledTaskUpdateRequestSchema,
      invalidBodyMessage: "Invalid scheduled task update request",
      async handler({ req, res, userId, body }) {
        const workspaceId = routeWorkspaceId(req.params.workspaceId);
        const scheduledTaskId = routeScheduledTaskId(req.params.scheduledTaskId);
        const agentId = routeOptionalAgentId(req.query.agentId);
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        return res.status(200).json(
          await updateScheduledTaskForWorkspace({
            workspaceId,
            scheduledTaskId,
            agentId,
            request: body,
          }),
        );
      },
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/scheduled-tasks/:scheduledTaskId/run-now",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = routeWorkspaceId(req.params.workspaceId);
        const scheduledTaskId = routeScheduledTaskId(req.params.scheduledTaskId);
        const agentId = routeOptionalAgentId(req.query.agentId);
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        return res.status(200).json(await runScheduledTaskNowForWorkspace({ workspaceId, scheduledTaskId, agentId }));
      },
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/scheduled-tasks/:scheduledTaskId/cancel",
    apiRoute({
      requireAuth: true,
      bodySchema: ScheduledTaskCancelRequestSchema,
      invalidBodyMessage: "Invalid scheduled task cancel request",
      async handler({ req, res, userId, body }) {
        const workspaceId = routeWorkspaceId(req.params.workspaceId);
        const scheduledTaskId = routeScheduledTaskId(req.params.scheduledTaskId);
        const agentId = routeOptionalAgentId(req.query.agentId);
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        return res.status(200).json(
          await cancelScheduledTaskForWorkspace({
            workspaceId,
            scheduledTaskId,
            agentId,
            reason: body.reason,
          }),
        );
      },
    }),
  );

  app.post(
    "/api/internal/scheduled-tasks/:scheduledTaskId/dispatch",
    apiRoute({
      bodySchema: ScheduledTaskDispatchRequestSchema,
      invalidBodyMessage: "workspaceId is required",
      async handler({ req, res, body }) {
        requireServiceRoleBearer(req);
        const scheduledTaskId = routeScheduledTaskId(req.params.scheduledTaskId);
        return res.status(200).json(
          await dispatchScheduledTaskForWorkspace({
            workspaceId: body.workspaceId,
            scheduledTaskId,
          }),
        );
      },
    }),
  );
}
