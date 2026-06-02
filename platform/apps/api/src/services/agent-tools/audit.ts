import type { AgentToolBundleName } from "../../../../../contracts/tool-definition.js";
import { logEvent } from "../../logger.js";

export function logAgentToolOverrideAudit(input: {
  action: "include" | "exclude" | "replace_bundles";
  userId: string;
  agentId: string;
  workspaceId: string;
  toolName?: string;
  bundles?: readonly AgentToolBundleName[];
}) {
  logEvent({
    event: "agent_tool_override_changed",
    audit: true,
    action: input.action,
    user_id: input.userId,
    agent_id: input.agentId,
    workspace_id: input.workspaceId,
    tool_name: input.toolName,
    bundles: input.bundles,
  });
}
