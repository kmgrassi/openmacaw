import { ApiRouteError } from "../../http.js";
import { findSetupAgentById } from "../../repositories/agents.js";
import { assertWorkspaceMembership } from "../work-item-ingest.js";

function isWorkspaceAuthorizationMiss(error: unknown) {
  return error instanceof Error && error.message === "Authenticated user is not authorized for the requested workspace";
}

export async function assertWorkspaceAccess(userId: string, workspaceId: string) {
  try {
    await assertWorkspaceMembership(userId, workspaceId);
  } catch (error) {
    if (isWorkspaceAuthorizationMiss(error)) {
      throw new ApiRouteError(403, "workspace_forbidden", "User is not authorized for the target workspace");
    }
    throw new ApiRouteError(
      502,
      "workspace_membership_check_failed",
      "Could not verify workspace membership",
      String(error),
    );
  }
}

export async function assertAgentAccess(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}) {
  const agent = await findSetupAgentById(input.accessToken, input.agentId);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  const agentWorkspaceId = agent.workspace_id?.trim() || "";
  if (!agentWorkspaceId) {
    throw new ApiRouteError(409, "agent_workspace_missing", "Agent is not assigned to a workspace");
  }

  if (input.workspaceId && input.workspaceId !== agentWorkspaceId) {
    throw new ApiRouteError(403, "agent_tool_forbidden", "Agent does not belong to the requested workspace");
  }

  await assertWorkspaceAccess(input.userId, agentWorkspaceId);
  return { agent, workspaceId: agentWorkspaceId };
}
