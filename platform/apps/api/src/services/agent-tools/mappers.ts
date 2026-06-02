import type { Json } from "@kmgrassi/supabase-schema";
import type {
  AgentToolGrant,
  AgentToolGrantMode,
  AgentToolGrantSource,
  ResolvedAgentTool,
  ToolDefinition,
  ToolPolicyTemplate,
} from "../../../../../contracts/tool-definition.js";
import type { GrantResolverToolRow } from "../agent-tool-grant-resolver.js";
import type { AgentToolGrantRow, ToolPolicyTemplateRow, ToolRow } from "../../repositories/agent-tools.js";

function parametersFromJson(value: Json | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function examplesFromJson(value: Json | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function toolFromRow(row: ToolRow | GrantResolverToolRow): ToolDefinition {
  const slug = row.slug ?? row.function_name ?? row.id;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug,
    name: row.name ?? slug,
    description: row.description ?? "",
    parameters: parametersFromJson(row.parameters),
    examples: examplesFromJson(row.examples),
    executionKind: row.execution_kind ?? null,
    runnerKind: row.runner_kind ?? null,
    enabled: row.enabled,
  };
}

export function templateFromRow(row: ToolPolicyTemplateRow): ToolPolicyTemplate {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name ?? row.slug,
    description: row.description ?? "",
    systemManaged: row.system_managed ?? false,
    enabled: row.enabled ?? true,
  };
}

export function grantMode(value: string): AgentToolGrantMode {
  return value === "exclude" ? "exclude" : "include";
}

export function grantSource(value: string): AgentToolGrantSource {
  if (value === "template" || value === "system" || value === "migration") return value;
  return "manual";
}

export function grantFromRow(row: AgentToolGrantRow): AgentToolGrant {
  return {
    id: row.id,
    agentId: row.agent_id,
    toolId: row.tool_id,
    workspaceId: row.workspace_id,
    mode: grantMode(row.mode),
    source: grantSource(row.source),
    sourceToolTemplateId: row.source_tool_template_id,
    reason: row.reason,
    createdByUserId: row.created_by_user_id,
  };
}

export function sortedTools(rows: ToolRow[]) {
  return rows
    .map(toolFromRow)
    .sort((left, right) => left.slug.localeCompare(right.slug) || left.name.localeCompare(right.name));
}

export function sortedResolvedTools(tools: ResolvedAgentTool[]) {
  return [...tools].sort((left, right) => left.slug.localeCompare(right.slug) || left.name.localeCompare(right.name));
}

export function sortedTemplates(rows: ToolPolicyTemplateRow[]) {
  return rows
    .map(templateFromRow)
    .sort((left, right) => left.slug.localeCompare(right.slug) || left.name.localeCompare(right.name));
}

export function sortedGrants(rows: AgentToolGrantRow[]) {
  return rows
    .map(grantFromRow)
    .sort((left, right) => left.toolId.localeCompare(right.toolId) || left.mode.localeCompare(right.mode));
}

export function toolName(row: ToolRow) {
  return row.slug ?? row.function_name ?? row.name ?? row.id;
}

export function toolMatchesName(row: ToolRow, name: string) {
  return row.slug === name || row.function_name === name || row.name === name;
}

export function resolvedToolFromGrant(input: { row: ToolRow; grant: AgentToolGrantRow }): ResolvedAgentTool {
  return {
    ...toolFromRow(input.row),
    source: grantSource(input.grant.source),
    enabledForAgent: grantMode(input.grant.mode) === "include",
  };
}
