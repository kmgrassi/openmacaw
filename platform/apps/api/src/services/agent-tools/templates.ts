import type { AgentToolSettingsResponse } from "../../../../../contracts/tool-definition.js";
import { getVisibleTemplateRow, listTemplateToolRows, listVisibleToolRows } from "../../repositories/agent-tools.js";
import type { ToolRow } from "../../repositories/agent-tools.js";
import { assertAgentAccess } from "./access.js";
import { logAgentToolOverrideAudit } from "./audit.js";
import { getAgentToolSettings } from "./settings.js";
import { upsertAgentToolGrantRow } from "../../repositories/agent-tools.js";
import { assertLocalCodingToolsAllowed } from "./validation.js";

export async function applyToolPolicyTemplateToAgent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  templateId: string;
  workspaceId?: string | null;
}): Promise<AgentToolSettingsResponse> {
  const { workspaceId } = await assertAgentAccess(input);
  await getVisibleTemplateRow(input.templateId, workspaceId);
  const [templateToolRows, availableToolRows] = await Promise.all([
    listTemplateToolRows(input.templateId),
    listVisibleToolRows(workspaceId),
  ]);
  const toolsById = new Map(availableToolRows.map((tool) => [tool.id, tool]));
  const selectedTools = templateToolRows
    .filter((row) => row.workspace_id === null || row.workspace_id === workspaceId)
    .map((row) => toolsById.get(row.tool_id))
    .filter((tool): tool is ToolRow => Boolean(tool));
  await assertLocalCodingToolsAllowed({ workspaceId, tools: selectedTools });

  for (const tool of selectedTools) {
    await upsertAgentToolGrantRow({
      userId: input.userId,
      agentId: input.agentId,
      workspaceId,
      toolId: tool.id,
      mode: "include",
      source: "template",
      sourceToolTemplateId: input.templateId,
      reason: "Applied tool policy template",
    });
  }

  logAgentToolOverrideAudit({
    action: "include",
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolName: `template:${input.templateId}`,
  });
  return getAgentToolSettings(input);
}
