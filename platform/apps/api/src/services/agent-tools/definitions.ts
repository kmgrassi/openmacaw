import type { Json, TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";
import type {
  AppendToolExamplesRequest,
  CreateToolDefinitionRequest,
  ToolDefinition,
  UpdateToolDefinitionRequest,
} from "../../../../../contracts/tool-definition.js";
import { ApiRouteError } from "../../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../../supabase-client.js";
import {
  getVisibleToolRow,
  getVisibleToolRowBySlug,
  getWorkspaceToolRow,
  listAllVisibleToolRows,
  TOOL_SELECT,
} from "../../repositories/agent-tools.js";
import type { ToolRow } from "../../repositories/agent-tools.js";
import { assertWorkspaceAccess } from "./access.js";
import { sortedTools, toolFromRow } from "./mappers.js";
import { validateToolParameters } from "./validation.js";

export async function listTools(input: { userId: string; workspaceId: string }): Promise<ToolDefinition[]> {
  await assertWorkspaceAccess(input.userId, input.workspaceId);
  return sortedTools(await listAllVisibleToolRows(input.workspaceId));
}

export async function createTool(input: {
  userId: string;
  request: CreateToolDefinitionRequest;
}): Promise<ToolDefinition> {
  await assertWorkspaceAccess(input.userId, input.request.workspaceId);
  const parameters = input.request.parameters ?? {};
  validateToolParameters(parameters);

  const rows = await executeSupabaseRows<ToolRow>(
    "tool insert",
    getServiceRoleSupabase()
      .from("tool")
      .insert({
        slug: input.request.slug,
        name: input.request.name,
        description: input.request.description ?? "",
        parameters: parameters as Json,
        examples: (input.request.examples ?? []) as Json,
        function_name: input.request.slug,
        execution_kind: input.request.executionKind ?? null,
        runner_kind: input.request.runnerKind ?? null,
        created_by_user_id: input.userId,
        workspace_id: input.request.workspaceId,
      } satisfies TablesInsert<"tool">)
      .select(TOOL_SELECT),
  );
  const tool = rows[0] ?? null;
  if (!tool) {
    throw new ApiRouteError(502, "tool_create_failed", "Tool was not created");
  }
  return toolFromRow(tool);
}

export async function updateTool(input: {
  userId: string;
  toolId: string;
  request: UpdateToolDefinitionRequest;
}): Promise<ToolDefinition> {
  await assertWorkspaceAccess(input.userId, input.request.workspaceId);
  const existingTool = await getWorkspaceToolRow(input.toolId, input.request.workspaceId);
  if (!existingTool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }
  if (input.request.parameters) validateToolParameters(input.request.parameters);

  const body: TablesUpdate<"tool"> = {};
  if (input.request.slug !== undefined) body.slug = input.request.slug;
  if (input.request.name !== undefined) body.name = input.request.name;
  if (input.request.description !== undefined) body.description = input.request.description;
  if (input.request.parameters !== undefined) body.parameters = input.request.parameters as Json;
  if (input.request.examples !== undefined) body.examples = input.request.examples as Json;
  if (input.request.executionKind !== undefined) body.execution_kind = input.request.executionKind;
  if (input.request.runnerKind !== undefined) body.runner_kind = input.request.runnerKind;
  body.updated_at = new Date().toISOString();

  const rows = await executeSupabaseRows<ToolRow>(
    "tool update",
    getServiceRoleSupabase()
      .from("tool")
      .update(body)
      .eq("id", input.toolId)
      .eq("workspace_id", input.request.workspaceId)
      .select(TOOL_SELECT),
  );
  const tool = rows[0] ?? null;
  if (!tool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }
  return toolFromRow(tool);
}

export async function appendToolExamples(input: {
  userId: string;
  toolId?: string;
  slug?: string;
  request: AppendToolExamplesRequest;
}): Promise<ToolDefinition> {
  await assertWorkspaceAccess(input.userId, input.request.workspaceId);
  const existingTool = input.toolId
    ? await getVisibleToolRow(input.toolId, input.request.workspaceId)
    : input.slug
      ? await getVisibleToolRowBySlug(input.slug, input.request.workspaceId)
      : null;
  if (!existingTool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }

  const currentExamples = Array.isArray(existingTool.examples) ? existingTool.examples : [];
  const examples = [...currentExamples, ...input.request.examples];

  const rows = await executeSupabaseRows<ToolRow>(
    "tool examples update",
    getServiceRoleSupabase()
      .from("tool")
      .update({
        examples: examples as Json,
        updated_at: new Date().toISOString(),
      } satisfies TablesUpdate<"tool">)
      .eq("id", existingTool.id)
      .select(TOOL_SELECT),
  );
  const tool = rows[0] ?? null;
  if (!tool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }
  return toolFromRow(tool);
}

export async function deleteTool(input: { userId: string; workspaceId: string; toolId: string }) {
  await assertWorkspaceAccess(input.userId, input.workspaceId);
  const rows = await executeSupabaseRows<ToolRow>(
    "tool delete",
    getServiceRoleSupabase()
      .from("tool")
      .delete()
      .eq("id", input.toolId)
      .eq("workspace_id", input.workspaceId)
      .select(TOOL_SELECT),
  );
  if (rows.length === 0) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }
}
