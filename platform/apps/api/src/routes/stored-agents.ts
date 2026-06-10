import type { Express } from "express";

import {
  AgentRuntimeProfileResponseSchema,
  AgentRuntimeProfileUpdateRequestSchema,
  StoredAgentListResponseSchema,
} from "../../../../contracts/agents.js";
import { AgentAssignLocalModelRequestSchema } from "../../../../contracts/local-runtime.js";
import { AgentRouteTemplates, StoredAgentRouteTemplates } from "../../../../contracts/routes.js";
import {
  StoredAgentCreateRequestSchema,
  StoredAgentGatewayConfigUpdateRequestSchema,
  StoredAgentMutationResponseSchema,
  StoredAgentUpdateRequestSchema,
} from "../../../../contracts/stored-agent-management.js";
import { ApiRouteError, apiRoute, handleApiRouteError, requireRouteParam } from "../http.js";
import { errorMessage, logEvent } from "../logger.js";
import { registerCredentialAliasRoutes } from "./credential-aliases.js";
import { registerStoredAgentCredentialRoutes } from "./stored-agent-credentials.js";
import { buildRequirementStatusFromResolution } from "../services/setup/builders.js";
import { resolveExecutionProfile } from "../services/execution-profile-resolver.js";
import type { LauncherClient } from "../services/launcher.js";
import {
  createStoredAgentFromApi,
  deleteStoredAgentFromApi,
  isStoredAgentRuntimeSelectable,
  listStoredAgentsFromSupabase,
  updateStoredAgentFromApi,
} from "../services/stored-agent-management.js";
import { getAgentRuntimeProfile, updateAgentRuntimeProfile } from "../services/agent-runtime-profile.js";
import { assignLocalModelByMachineToAgent } from "../services/local-runtime-helpers.js";

export { ensureStoredAgentDefaultRouting } from "../services/stored-agent-routing.js";

async function buildStoredAgentAuthState(input: { accessToken: string; userId: string }) {
  const agents = await listStoredAgentsFromSupabase(input);
  const agentsWithConfigurationStatus = await Promise.all(
    agents.map(async (agent) => {
      try {
        const resolution = await resolveExecutionProfile({
          accessToken: input.accessToken,
          requesterUserId: input.userId,
          agentId: agent.id,
        });
        const { configured, missing } = buildRequirementStatusFromResolution(resolution);

        return {
          ...agent,
          configurationStatus: {
            configured,
            missing,
          },
        };
      } catch (error) {
        logEvent({
          level: "warn",
          event: "stored_agent_configuration_status_unavailable",
          agent_id: agent.id,
          workspace_id: agent.workspaceId,
          error: errorMessage(error),
        });
        return {
          ...agent,
          configurationStatus: null,
        };
      }
    }),
  );
  const resolved =
    agentsWithConfigurationStatus.find((agent) => agent.isResolved && isStoredAgentRuntimeSelectable(agent)) ??
    agentsWithConfigurationStatus.find(isStoredAgentRuntimeSelectable) ??
    null;

  return {
    readyToPrepare: Boolean(resolved?.id && resolved?.workspaceId),
    reasons: resolved ? [] : ["missing_usable_agent"],
    resolvedAgentId: resolved?.id ?? null,
    workspaceId: resolved?.workspaceId ?? null,
    agents: agentsWithConfigurationStatus,
  };
}

function registerStoredAgentCrudRoutes(app: Express) {
  app.get(
    StoredAgentRouteTemplates.collection,
    apiRoute({
      requireAuth: true,
      handler: async ({ res, accessToken, userId }) => {
        const authState = await buildStoredAgentAuthState({ accessToken: accessToken ?? "", userId: userId ?? "" });
        return res.status(200).json(StoredAgentListResponseSchema.parse({ agents: authState.agents }));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "supabase_unreachable",
          message: "Could not read stored agents from Supabase",
        }),
    }),
  );

  app.post(
    StoredAgentRouteTemplates.collection,
    apiRoute({
      requireAuth: true,
      bodySchema: StoredAgentCreateRequestSchema,
      invalidBodyMessage: "Stored agent request is invalid",
      handler: async ({ res, body, accessToken, userId }) => {
        const agent = await createStoredAgentFromApi({
          accessToken: accessToken ?? "",
          userId: userId ?? "",
          body,
        });
        return res.status(201).json(StoredAgentMutationResponseSchema.parse({ agent }));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "stored_agent_create_failed",
          message: "Could not create stored agent",
        }),
    }),
  );

  app.patch(
    StoredAgentRouteTemplates.item,
    apiRoute({
      requireAuth: true,
      bodySchema: StoredAgentUpdateRequestSchema,
      invalidBodyMessage: "Stored agent update is invalid",
      handler: async ({ req, res, body, accessToken, userId }) => {
        const agentId = requireRouteParam(req, "agentId");
        const agent = await updateStoredAgentFromApi({
          accessToken: accessToken ?? "",
          userId: userId ?? "",
          agentId,
          body,
        });
        return res.status(200).json(StoredAgentMutationResponseSchema.parse({ agent }));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "stored_agent_update_failed",
          message: "Could not update stored agent",
        }),
    }),
  );

  app.delete(
    StoredAgentRouteTemplates.item,
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, accessToken }) => {
        const agentId = requireRouteParam(req, "agentId");
        await deleteStoredAgentFromApi({
          accessToken: accessToken ?? "",
          agentId,
        });
        return res.status(204).send();
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "stored_agent_delete_failed",
          message: "Could not delete stored agent",
        }),
    }),
  );

  app.get(
    StoredAgentRouteTemplates.gatewayConfig,
    apiRoute({
      requireAuth: true,
      handler: async () => {
        throw new ApiRouteError(501, "not_implemented", "Stored agent gateway config read is not implemented yet");
      },
    }),
  );

  app.put(
    StoredAgentRouteTemplates.gatewayConfig,
    apiRoute({
      bodySchema: StoredAgentGatewayConfigUpdateRequestSchema,
      invalidBodyMessage: "Stored agent gateway config request is invalid",
      requireAuth: true,
      handler: async () => {
        throw new ApiRouteError(501, "not_implemented", "Stored agent gateway config update is not implemented yet");
      },
    }),
  );

  for (const path of [StoredAgentRouteTemplates.runtimeProfile, AgentRouteTemplates.runtimeProfile]) {
    app.get(
      path,
      apiRoute({
        requireAuth: true,
        handler: async ({ req, res, accessToken, userId }) => {
          const agentId = requireRouteParam(req, "agentId");
          const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : null;
          const profile = await getAgentRuntimeProfile({
            accessToken: accessToken ?? "",
            userId: userId ?? "",
            agentId,
            workspaceId,
          });
          return res.status(200).json(AgentRuntimeProfileResponseSchema.parse({ profile }));
        },
        onError: (res, error) =>
          handleApiRouteError(res, error, {
            status: 502,
            code: "runtime_profile_read_failed",
            message: "Could not read agent runtime profile",
          }),
      }),
    );

    app.put(
      path,
      apiRoute({
        requireAuth: true,
        bodySchema: AgentRuntimeProfileUpdateRequestSchema,
        invalidBodyMessage: "Agent runtime profile request is invalid",
        handler: async ({ req, res, body, accessToken, userId }) => {
          const agentId = requireRouteParam(req, "agentId");
          const profile = await updateAgentRuntimeProfile({
            accessToken: accessToken ?? "",
            userId: userId ?? "",
            agentId,
            body,
          });
          return res.status(200).json(AgentRuntimeProfileResponseSchema.parse({ profile }));
        },
        onError: (res, error) =>
          handleApiRouteError(res, error, {
            status: 502,
            code: "runtime_profile_update_failed",
            message: "Could not update agent runtime profile",
          }),
      }),
    );
  }

  app.post(
    AgentRouteTemplates.assignLocalModel,
    apiRoute({
      requireAuth: true,
      bodySchema: AgentAssignLocalModelRequestSchema,
      invalidBodyMessage: "Local model assignment request is invalid",
      handler: async ({ req, res, body, accessToken, userId }) => {
        if (!userId) {
          throw new ApiRouteError(401, "unauthorized", "User ID is required");
        }

        const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";
        if (!workspaceId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        }

        const response = await assignLocalModelByMachineToAgent({
          workspaceId,
          agentId: requireRouteParam(req, "agentId"),
          machineId: body.machineId,
          model: body.model,
          provider: body.provider,
          auth: {
            accessToken: accessToken ?? "",
            userId,
          },
        });
        return res.status(201).json(response);
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_model_assign_failed",
          message: "Could not assign local model to agent",
        }),
    }),
  );
}

export function registerStoredAgentRoutes(app: Express, launcherClient: LauncherClient) {
  registerCredentialAliasRoutes(app);
  registerStoredAgentCrudRoutes(app);
  registerStoredAgentCredentialRoutes(app, launcherClient);
}
