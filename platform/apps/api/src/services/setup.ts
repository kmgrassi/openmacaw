import type {
  AgentCredentialConfigurationRequest,
  SetupRequest,
  SetupUpdateRequest,
} from "../../../../contracts/setup.js";
import type { LauncherClient } from "./launcher.js";
import { withServiceLogging } from "./service-logging.js";
import type { LauncherRequest } from "./setup/launcher-orchestration.js";
import { configureSetupAgentCredentialsImpl } from "./setup/orchestration/configure-credentials.js";
import { createSetupImpl } from "./setup/orchestration/create.js";
import { getAgentHealthImpl, getSetupImpl } from "./setup/orchestration/read.js";
import { updateSetupImpl } from "./setup/orchestration/update.js";

export {
  activateManagerAgentCredentials,
  applyDefaultAgentCredentials,
  getDefaultAgentStatusForWorkspace,
  listSetupAuthState,
  updateDefaultAgentAssignment,
} from "./setup/default-agents.js";

export async function configureSetupAgentCredentials(
  accessToken: string,
  verifiedUserId: string,
  input: AgentCredentialConfigurationRequest,
) {
  return withServiceLogging(
    {
      operation: "setup.configure_agent_credentials",
      inputSummary: {
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        provider: input.provider,
        has_model: Boolean(input.model),
      },
    },
    () => configureSetupAgentCredentialsImpl(accessToken, verifiedUserId, input),
  );
}

export async function createSetup(
  accessToken: string,
  verifiedUserId: string,
  input: SetupRequest,
  launcherClient: LauncherClient,
  launcherRequest?: LauncherRequest,
) {
  return withServiceLogging(
    {
      operation: "setup.create",
      inputSummary: {
        workspace_id: input.workspaceId,
        has_agent_name: Boolean(input.agentName),
        credential_count: input.credentials.length,
        has_launcher_request: Boolean(launcherRequest),
      },
    },
    () => createSetupImpl(accessToken, verifiedUserId, input, launcherClient, launcherRequest),
  );
}

export async function getSetup(
  accessToken: string,
  verifiedUserId: string,
  agentId: string,
  launcherRequest?: LauncherRequest,
) {
  return withServiceLogging(
    {
      operation: "setup.get",
      inputSummary: {
        agent_id: agentId,
        has_launcher_request: Boolean(launcherRequest),
      },
    },
    () => getSetupImpl(accessToken, verifiedUserId, agentId, launcherRequest),
  );
}

export async function getAgentHealth(
  accessToken: string,
  verifiedUserId: string,
  agentId: string,
  launcherClient: LauncherClient,
) {
  return withServiceLogging(
    {
      operation: "setup.get_agent_health",
      inputSummary: { agent_id: agentId },
    },
    () => getAgentHealthImpl(accessToken, verifiedUserId, agentId, launcherClient),
  );
}

export async function updateSetup(
  accessToken: string,
  verifiedUserId: string,
  input: SetupUpdateRequest,
  launcherClient: LauncherClient,
  launcherRequest?: LauncherRequest,
) {
  return withServiceLogging(
    {
      operation: "setup.update",
      inputSummary: {
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        credential_count: input.credentials.length,
        has_launcher_request: Boolean(launcherRequest),
      },
    },
    () => updateSetupImpl(accessToken, verifiedUserId, input, launcherClient, launcherRequest),
  );
}
