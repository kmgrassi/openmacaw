import type { DefaultAgentRole } from "../../../../contracts/setup.js";
import { ApiRouteError } from "../http.js";
import { findSetupAgentById } from "../repositories/agents.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import {
  writeGatewayConfigForDefaultAgent,
  writeGatewayConfigForManagerAgent,
} from "./setup/store/gateway-config-writer.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

function actorUserId(userId: string | null | undefined) {
  const trimmed = userId?.trim();
  return trimmed || SYSTEM_USER_ID;
}

export async function syncAgentGatewayConfigForExecutionProfile(input: {
  accessToken: string;
  userId?: string | null;
  agentId: string;
}) {
  const resolution = await resolveExecutionProfile({
    accessToken: input.accessToken,
    requesterUserId: input.userId ?? undefined,
    agentId: input.agentId,
    skipCredentialCheck: true,
  });
  const role = resolution.agent?.role;
  const profile = resolution.profile;

  if (!role || !profile?.model || !profile.provider) {
    return { changed: false, resolution };
  }

  if (role !== "planning" && role !== "coding" && role !== "manager") {
    return { changed: false, resolution };
  }

  const agent = await findSetupAgentById(input.accessToken, input.agentId);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  if (role === "manager") {
    await writeGatewayConfigForManagerAgent({
      accessToken: input.accessToken,
      userId: actorUserId(input.userId),
      agent,
      provider: profile.provider,
      model: profile.model,
      runnerKind: "llm_tool_runner",
    });
    return { changed: true, resolution };
  }

  await writeGatewayConfigForDefaultAgent(
    input.accessToken,
    actorUserId(input.userId),
    agent,
    role as DefaultAgentRole,
    profile.provider,
    profile.model,
    profile.runnerKind,
  );
  return { changed: true, resolution };
}
