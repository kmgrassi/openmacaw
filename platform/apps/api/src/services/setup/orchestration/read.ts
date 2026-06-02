import type { LauncherClient } from "../../launcher.js";
import { getAgentHealth as buildAgentHealth } from "../health.js";
import { requireCurrentUser } from "../identity.js";
import type { LauncherRequest } from "../launcher-orchestration.js";
import { assembleSetup } from "./assemble.js";

export async function getSetupImpl(
  accessToken: string,
  verifiedUserId: string,
  agentId: string,
  launcherRequest?: LauncherRequest,
) {
  const userId = requireCurrentUser(verifiedUserId);
  return assembleSetup(accessToken, userId, agentId, launcherRequest);
}

export async function getAgentHealthImpl(
  accessToken: string,
  verifiedUserId: string,
  agentId: string,
  launcherClient: LauncherClient,
) {
  requireCurrentUser(verifiedUserId);
  return buildAgentHealth(accessToken, verifiedUserId, agentId, launcherClient);
}
