import type { AgentToolGrant } from "../../../../../../contracts/tool-definition";
import type { ToolDefinition } from "../../../hooks/useToolDefinitions";

type ToolBundle = {
  id: string;
  label: string;
  match: (tool: ToolDefinition) => boolean;
};

export const TOOL_BUNDLES: ToolBundle[] = [
  {
    id: ":planner",
    label: "Planner",
    match: (tool) =>
      textIncludes(tool, "plan") || textIncludes(tool, "work item"),
  },
  {
    id: ":manager",
    label: "Manager",
    match: (tool) =>
      textIncludes(tool, "manager") || textIncludes(tool, "handoff"),
  },
  {
    id: ":coding",
    label: "Coding",
    match: (tool) =>
      tool.runnerKind === "local_model_coding" || textIncludes(tool, "code"),
  },
  {
    id: ":repo_read",
    label: "Repo read",
    match: (tool) =>
      tool.executionKind === "filesystem_read" || textIncludes(tool, "read"),
  },
  {
    id: ":repo_write",
    label: "Repo write",
    match: (tool) =>
      tool.executionKind === "filesystem_write" ||
      tool.executionKind === "git" ||
      textIncludes(tool, "write"),
  },
];

export function textIncludes(tool: ToolDefinition, needle: string) {
  const haystack =
    `${tool.slug} ${tool.name} ${tool.description}`.toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

export function formatSchema(parameters: Record<string, unknown>) {
  const schema = JSON.stringify(parameters, null, 2);
  return schema === "{}" ? "{\n  \n}" : schema;
}

export function bundleIdsForTool(tool: ToolDefinition) {
  return TOOL_BUNDLES.filter((bundle) => bundle.match(tool)).map(
    (bundle) => bundle.id,
  );
}

export function sourceLabel(
  tool: ToolDefinition,
  initialAssignedIds: Set<string>,
  draftAssignedIds: Set<string>,
  grantsByToolId: Map<string, AgentToolGrant>,
) {
  if (!initialAssignedIds.has(tool.id) && draftAssignedIds.has(tool.id))
    return "include";
  const grant = grantsByToolId.get(tool.id);
  if (!grant) return "resolved";
  return grant.source === "template" && grant.sourceToolTemplateId
    ? "template"
    : grant.source;
}
