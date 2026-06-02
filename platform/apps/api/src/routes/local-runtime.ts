import type { Express, Request } from "express";

import { LocalRuntimeRouteTemplates } from "../../../../contracts/routes.js";
import {
  LocalModelProbeRequestSchema,
  LocalRuntimeRegistrationRequestSchema,
} from "../../../../contracts/local-runtime.js";
import { ApiRouteError, apiRoute, handleApiRouteError, requestWorkspaceId, requireRouteParam } from "../http.js";
import { assignLocalModelToAgent, unassignLocalModelFromAgent } from "../services/local-runtime-helpers.js";
import {
  deleteLocalRuntimeForWorkspace,
  getLocalRuntimeConfigForWorkspace,
  listLocalRuntimesForWorkspace,
  probeLocalModel,
  probeRegisteredLocalRuntimeForWorkspace,
  registerLocalRuntimeForWorkspace,
  rotateLocalRuntimeTokenForWorkspace,
} from "../services/local-runtime-machines.js";

function requireWorkspaceId(req: Request) {
  const workspaceId = requestWorkspaceId(req);
  if (!workspaceId) {
    throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
  }
  return workspaceId;
}

export function registerLocalRuntimeRoutes(app: Express) {
  app.post(
    LocalRuntimeRouteTemplates.collection,
    apiRoute({
      requireAuth: true,
      bodySchema: LocalRuntimeRegistrationRequestSchema,
      invalidBodyMessage: "Local runtime registration request is invalid",
      async handler({ req, res, body, userId }) {
        if (!userId) {
          throw new ApiRouteError(401, "unauthorized", "User ID is required");
        }

        const response = await registerLocalRuntimeForWorkspace({
          workspaceId: requireWorkspaceId(req),
          userId,
          request: body,
        });
        return res.status(201).json(response);
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_create_failed",
          message: "Could not register local runtime",
        }),
    }),
  );

  app.get(
    LocalRuntimeRouteTemplates.collection,
    apiRoute({
      requireAuth: true,
      async handler({ req, res }) {
        return res.status(200).json(await listLocalRuntimesForWorkspace(requireWorkspaceId(req)));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_list_failed",
          message: "Could not list local runtimes",
        }),
    }),
  );

  app.post(
    LocalRuntimeRouteTemplates.probe,
    apiRoute({
      requireAuth: true,
      bodySchema: LocalModelProbeRequestSchema,
      invalidBodyMessage: "Local runtime probe request is invalid",
      async handler({ res, body }) {
        return res.status(200).json(await probeLocalModel(body));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_probe_failed",
          message: "Could not probe local runtime",
        }),
    }),
  );

  app.get(
    LocalRuntimeRouteTemplates.config,
    apiRoute({
      requireAuth: true,
      async handler({ req, res }) {
        return res
          .status(200)
          .json(await getLocalRuntimeConfigForWorkspace(requireWorkspaceId(req), requireRouteParam(req, "machineId")));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_config_failed",
          message: "Could not regenerate local runtime config",
        }),
    }),
  );

  app.post(
    LocalRuntimeRouteTemplates.rotateToken,
    apiRoute({
      requireAuth: true,
      async handler({ req, res }) {
        return res
          .status(201)
          .json(
            await rotateLocalRuntimeTokenForWorkspace(requireWorkspaceId(req), requireRouteParam(req, "machineId")),
          );
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_token_rotate_failed",
          message: "Could not rotate local runtime helper token",
        }),
    }),
  );

  // Probe targets a specific runner (routing rule), not the machine, because
  // only the openai_compatible runner exposes an OpenAI-compatible /models list.
  app.post(
    LocalRuntimeRouteTemplates.runnerProbe,
    apiRoute({
      requireAuth: true,
      async handler({ req, res }) {
        return res
          .status(200)
          .json(
            await probeRegisteredLocalRuntimeForWorkspace(requireWorkspaceId(req), requireRouteParam(req, "runnerId")),
          );
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_probe_failed",
          message: "Could not probe local runtime",
        }),
    }),
  );

  app.delete(
    LocalRuntimeRouteTemplates.item,
    apiRoute({
      requireAuth: true,
      async handler({ req, res }) {
        await deleteLocalRuntimeForWorkspace(requireWorkspaceId(req), requireRouteParam(req, "machineId"));
        return res.status(204).end();
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_delete_failed",
          message: "Could not delete local runtime",
        }),
    }),
  );

  app.post(
    LocalRuntimeRouteTemplates.assignRunner,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        if (!userId) {
          throw new ApiRouteError(401, "unauthorized", "User ID is required");
        }

        const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
        if (!agentId) {
          throw new ApiRouteError(400, "invalid_request", "agentId is required");
        }

        const response = await assignLocalModelToAgent({
          workspaceId: requireWorkspaceId(req),
          ruleId: requireRouteParam(req, "runnerId"),
          agentId,
          userId,
        });
        return res.status(201).json(response);
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_assign_failed",
          message: "Could not assign local runtime to agent",
        }),
    }),
  );

  app.delete(
    LocalRuntimeRouteTemplates.unassignRunner,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        if (!userId) {
          throw new ApiRouteError(401, "unauthorized", "User ID is required");
        }

        await unassignLocalModelFromAgent({
          workspaceId: requireWorkspaceId(req),
          ruleId: requireRouteParam(req, "runnerId"),
          agentId: requireRouteParam(req, "agentId"),
          userId,
        });
        return res.status(204).end();
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_unassign_failed",
          message: "Could not remove local runtime assignment",
        }),
    }),
  );
}
