import { normalizeAgentType } from "../../../../../../contracts/agents.js";
import type { SetupUpdateRequest } from "../../../../../../contracts/setup.js";
import { ApiRouteError } from "../../../http.js";
import { findSetupAgentById, updateSetupAgent } from "../../../repositories/agents.js";
import { createAgentCredential } from "../../../repositories/credentials.js";
import { resolveExecutionProfile } from "../../execution-profile-resolver.js";
import type { LauncherClient } from "../../launcher.js";
import {
  agentType,
  asJson,
  buildChangeSummary,
  buildCredentialJson,
  buildExecutionProfileBlock,
  buildGatewayConfig,
  buildModelSettings,
  buildToolPolicy,
  hashConfig,
} from "../builders.js";
import { createGatewayConfigVersion, updateGatewayConfig } from "../gateway-config.js";
import { requireCurrentUser } from "../identity.js";
import { ensureLauncherStarted, type LauncherRequest, waitForEngineRunning } from "../launcher-orchestration.js";
import { getGatewayConfig } from "../store.js";
import { assembleSetup } from "./assemble.js";

export async function updateSetupImpl(
  accessToken: string,
  verifiedUserId: string,
  input: SetupUpdateRequest,
  launcherClient: LauncherClient,
  launcherRequest?: LauncherRequest,
) {
  const userId = requireCurrentUser(verifiedUserId);
  const existingAgent = await findSetupAgentById(accessToken, input.agentId);
  if (!existingAgent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  if (existingAgent.workspace_id !== input.workspaceId) {
    throw new ApiRouteError(400, "workspace_mismatch", "Agent workspace cannot be changed during setup update");
  }

  const type = agentType(input, normalizeAgentType(existingAgent.type));

  await updateSetupAgent({
    accessToken,
    agentId: input.agentId,
    name: input.agentName,
    type,
    modelSettings: buildModelSettings(input.model),
    toolPolicy: buildToolPolicy(input, type),
  });

  for (const credential of input.credentials) {
    await createAgentCredential({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      userId,
      credentialKey: buildCredentialJson(credential),
      accessToken,
    });
  }

  const existingGatewayConfig = await getGatewayConfig(accessToken, input.agentId);
  if (!existingGatewayConfig) {
    throw new ApiRouteError(404, "gateway_config_not_found", "Gateway config was not found for the agent");
  }

  // Resolve the execution profile after credentials are persisted so the
  // refreshed gateway_config carries the credential_id the runtime needs.
  const resolution = await resolveExecutionProfile({
    agentId: input.agentId,
    accessToken,
    skipCredentialCheck: true,
  }).catch(() => null);
  const nextConfigJson = buildGatewayConfig(
    input,
    type,
    existingGatewayConfig.config_json,
    buildExecutionProfileBlock(resolution),
  );
  const nextConfigHash = hashConfig(nextConfigJson);
  const nextVersion = existingGatewayConfig.version + 1;

  const updatedGatewayConfig = await updateGatewayConfig({
    accessToken,
    gatewayConfigId: existingGatewayConfig.id,
    userId,
    version: nextVersion,
    configHash: nextConfigHash,
    configJson: nextConfigJson,
  });

  if (!updatedGatewayConfig) {
    throw new ApiRouteError(502, "gateway_config_update_failed", "Gateway config update returned no row");
  }

  await createGatewayConfigVersion({
    accessToken,
    gatewayConfigId: updatedGatewayConfig.id,
    version: nextVersion,
    configHash: nextConfigHash,
    configJson: asJson(nextConfigJson),
    userId,
    changeSummary: buildChangeSummary(existingGatewayConfig.config_json, nextConfigJson),
  });

  await ensureLauncherStarted(launcherClient, existingAgent, accessToken);
  await waitForEngineRunning(accessToken, existingAgent.id, launcherRequest);
  return assembleSetup(accessToken, userId, existingAgent.id, launcherRequest);
}
