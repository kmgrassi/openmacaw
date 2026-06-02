import type { Express, Response } from "express";

import { AgentHealthResponseSchema } from "../../../../contracts/agent-health.js";
import {
  AgentCredentialConfigurationRequestSchema,
  AgentCredentialConfigurationResponseSchema,
  DefaultAgentAssignmentUpdateRequestSchema,
  DefaultAgentCredentialApplicationRequestSchema,
  DefaultAgentCredentialApplicationResponseSchema,
  ManagerCredentialActivationRequestSchema,
  ManagerCredentialActivationResponseSchema,
  SetupAuthStateSchema,
  SetupRequestSchema,
  SetupResponseSchema,
  SetupUpdateRequestSchema,
} from "../../../../contracts/setup.js";
import { apiRoute, handleApiRouteError, requireQueryParam, requireRouteParam } from "../http.js";
import type { LauncherClient } from "../services/launcher.js";
import type { UpstreamResponse } from "../services/upstream.js";
import {
  applyDefaultAgentCredentials,
  activateManagerAgentCredentials,
  configureSetupAgentCredentials,
  getAgentHealth,
  createSetup,
  getSetup,
  listSetupAuthState,
  updateDefaultAgentAssignment,
  updateSetup,
} from "../services/setup.js";

function handleSetupError(res: Response, error: unknown) {
  return handleApiRouteError(res, error, {
    status: 502,
    code: "setup_failed",
    message: "Setup request failed",
  });
}

type LauncherRequest = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

export function registerSetupRoutes(app: Express, launcherClient: LauncherClient, launcherRequest: LauncherRequest) {
  app.get(
    "/api/auth/state",
    apiRoute({
      requireAuth: true,
      onError: handleSetupError,
      async handler({ res, accessToken, userId }) {
        if (!accessToken || !userId) return;
        return res.status(200).json(SetupAuthStateSchema.parse(await listSetupAuthState(accessToken, userId)));
      },
    }),
  );

  app.put(
    "/api/default-agents/assignment",
    apiRoute({
      bodySchema: DefaultAgentAssignmentUpdateRequestSchema,
      invalidBodyMessage: "Default agent assignment update is invalid",
      requireAuth: true,
      onError: handleSetupError,
      async handler({ res, body, accessToken, userId }) {
        if (!accessToken || !userId) return;
        return res
          .status(200)
          .json(SetupAuthStateSchema.parse(await updateDefaultAgentAssignment(accessToken, userId, body)));
      },
    }),
  );

  app.post(
    "/api/default-agents/credentials",
    apiRoute({
      bodySchema: DefaultAgentCredentialApplicationRequestSchema,
      invalidBodyMessage: "Default agent credential request is invalid",
      requireAuth: true,
      onError: handleSetupError,
      async handler({ res, body, accessToken, userId }) {
        if (!accessToken || !userId) return;
        return res.status(200).json(
          DefaultAgentCredentialApplicationResponseSchema.parse({
            authState: await applyDefaultAgentCredentials(accessToken, userId, body),
          }),
        );
      },
    }),
  );

  app.post(
    "/api/setup/agent-credentials",
    apiRoute({
      bodySchema: AgentCredentialConfigurationRequestSchema,
      invalidBodyMessage: "Agent credential configuration request is invalid",
      requireAuth: true,
      onError: handleSetupError,
      async handler({ res, body, accessToken, userId }) {
        if (!accessToken || !userId) return;
        return res.status(200).json(
          AgentCredentialConfigurationResponseSchema.parse({
            setup: await configureSetupAgentCredentials(accessToken, userId, body),
          }),
        );
      },
    }),
  );

  app.post(
    "/api/manager-agent/activation",
    apiRoute({
      bodySchema: ManagerCredentialActivationRequestSchema,
      invalidBodyMessage: "Manager credential activation request is invalid",
      requireAuth: true,
      onError: handleSetupError,
      async handler({ res, body, accessToken, userId }) {
        if (!accessToken || !userId) return;
        return res.status(200).json(
          ManagerCredentialActivationResponseSchema.parse({
            authState: await activateManagerAgentCredentials(accessToken, userId, body),
          }),
        );
      },
    }),
  );

  app.post(
    "/api/setup",
    apiRoute({
      bodySchema: SetupRequestSchema,
      invalidBodyMessage: "Setup request is invalid",
      requireAuth: true,
      onError: handleSetupError,
      async handler({ res, body, accessToken, userId }) {
        if (!accessToken || !userId) return;
        return res
          .status(201)
          .json(
            SetupResponseSchema.parse(await createSetup(accessToken, userId, body, launcherClient, launcherRequest)),
          );
      },
    }),
  );

  app.put(
    "/api/setup",
    apiRoute({
      bodySchema: SetupUpdateRequestSchema,
      invalidBodyMessage: "Setup update is invalid",
      requireAuth: true,
      onError: handleSetupError,
      async handler({ res, body, accessToken, userId }) {
        if (!accessToken || !userId) return;
        return res
          .status(200)
          .json(
            SetupResponseSchema.parse(await updateSetup(accessToken, userId, body, launcherClient, launcherRequest)),
          );
      },
    }),
  );

  app.get(
    "/api/agents/:agentId/health",
    apiRoute({
      requireAuth: true,
      onError: handleSetupError,
      async handler({ req, res, accessToken, userId }) {
        if (!accessToken || !userId) return;
        return res
          .status(200)
          .json(
            AgentHealthResponseSchema.parse(
              await getAgentHealth(accessToken, userId, requireRouteParam(req, "agentId"), launcherClient),
            ),
          );
      },
    }),
  );

  app.get(
    "/api/setup",
    apiRoute({
      requireAuth: true,
      onError: handleSetupError,
      async handler({ req, res, accessToken, userId }) {
        if (!accessToken || !userId) return;
        const agentId = requireQueryParam(req, "agentId");
        return res
          .status(200)
          .json(SetupResponseSchema.parse(await getSetup(accessToken, userId, agentId, launcherRequest)));
      },
    }),
  );
}
