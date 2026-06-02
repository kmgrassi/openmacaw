import type { Json, TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";

import { ApiRouteError } from "../http.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { deletePlanForWorkspace } from "./workspace-plans.js";

import type { ToolDefinition } from "./tool-spec-translator.js";
import type { ToolExecutionContext } from "./tool-execution-client.js";
import { memoryResultTokenCount, retrieveRelevantMemories } from "./learning/memory-retriever.js";
import { isLearningEnabledForAgent } from "./learning/settings.js";

type DatabaseToolResult = {
  status?: number;
  output: string;
};

const SCHEDULED_TASK_SELECT =
  "id,agent_id,instructions,cron_schedule,next_interval,start_time,is_active,is_completed,is_follow_up,cancelled_reason,created_at,updated_at" as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key];
  return typeof value === "boolean" ? value : null;
}

function scheduleArg(args: Record<string, unknown>): Record<string, unknown> | null {
  const value = args.schedule ?? args.next_interval ?? args.nextInterval;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function scheduledTaskIdArg(args: Record<string, unknown>): string {
  return stringArg(args, "scheduledTaskId") || stringArg(args, "scheduled_task_id") || stringArg(args, "id");
}

function toolIdArg(args: Record<string, unknown>): string {
  return stringArg(args, "toolId") || stringArg(args, "tool_id") || stringArg(args, "id");
}

function toolSlugArg(args: Record<string, unknown>): string {
  return stringArg(args, "toolSlug") || stringArg(args, "tool_slug") || stringArg(args, "slug");
}

function toolKey(tool: ToolDefinition): string {
  return tool.slug || tool.functionName || tool.name;
}

function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function exampleArgs(args: Record<string, unknown>): unknown[] {
  if (Array.isArray(args.examples) && args.examples.length > 0) return args.examples;
  if (args.example !== undefined) return [args.example];
  return [];
}

async function assertAgentInWorkspace(agentId: string, workspaceId: string) {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("agent")
    .select("id,workspace_id")
    .eq("id", agentId)
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("agent query", error);
  if (!data) throw new ApiRouteError(404, "agent_not_found", "Agent was not found in the runtime workspace");
}

type ToolExamplesRow = {
  id: string;
  workspace_id: string | null;
  slug: string | null;
  name: string | null;
  examples: Json | null;
};

async function visibleToolById(toolId: string, workspaceId: string): Promise<ToolExamplesRow | null> {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("tool")
    .select("id,workspace_id,slug,name,examples")
    .eq("id", toolId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("tool query", error);
  if (!data || (data.workspace_id !== null && data.workspace_id !== workspaceId)) return null;
  return data;
}

async function visibleToolBySlug(slug: string, workspaceId: string): Promise<ToolExamplesRow | null> {
  const supabase = getServiceRoleSupabase();
  const { data: workspaceTool, error: workspaceError } = await supabase
    .from("tool")
    .select("id,workspace_id,slug,name,examples")
    .eq("slug", slug)
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (workspaceError) throw normalizeSupabaseError("tool query", workspaceError);
  if (workspaceTool) return workspaceTool;

  const { data: globalTool, error: globalError } = await supabase
    .from("tool")
    .select("id,workspace_id,slug,name,examples")
    .eq("slug", slug)
    .is("workspace_id", null)
    .limit(1)
    .maybeSingle();
  if (globalError) throw normalizeSupabaseError("tool query", globalError);
  return globalTool;
}

async function assertToolAssignedToAgent(agentId: string, workspaceId: string, toolId: string) {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("agent_tool_grant")
    .select("id")
    .eq("agent_id", agentId)
    .eq("workspace_id", workspaceId)
    .eq("tool_id", toolId)
    .eq("mode", "include")
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("agent tool grant query", error);
  if (!data) {
    throw new ApiRouteError(403, "tool_not_assigned", "Agents can only update examples for tools assigned to them");
  }
}

async function appendToolExamples(args: Record<string, unknown>, workspaceId: string, context?: ToolExecutionContext) {
  const agentId = context?.agentId?.trim() || "";
  if (!agentId) throw new ApiRouteError(400, "runtime_context_required", "agent_id is required in runtime context");

  const examples = exampleArgs(args);
  if (examples.length === 0) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "example or examples is required");
  }

  const targetToolId = toolIdArg(args);
  const targetToolSlug = toolSlugArg(args);
  if (!targetToolId && !targetToolSlug) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "tool_id or tool_slug is required");
  }

  const targetTool = targetToolId
    ? await visibleToolById(targetToolId, workspaceId)
    : await visibleToolBySlug(targetToolSlug, workspaceId);
  if (!targetTool) throw new ApiRouteError(404, "tool_not_found", "Tool was not found");

  await assertToolAssignedToAgent(agentId, workspaceId, targetTool.id);

  const existingExamples = Array.isArray(targetTool.examples) ? targetTool.examples : [];
  const updatedExamples = [...existingExamples, ...examples];
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("tool")
    .update({
      examples: updatedExamples as Json,
      updated_at: new Date().toISOString(),
    } satisfies TablesUpdate<"tool">)
    .eq("id", targetTool.id)
    .select("id,workspace_id,slug,name,examples")
    .single();
  if (error) throw normalizeSupabaseError("tool examples update", error);

  return {
    status: 200,
    output: jsonOutput({
      tool: data,
      appendedCount: examples.length,
      exampleCount: updatedExamples.length,
    }),
  };
}

async function workspaceAgentIds(workspaceId: string): Promise<string[]> {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase.from("agent").select("id").eq("workspace_id", workspaceId);
  if (error) throw normalizeSupabaseError("agent query", error);
  return (data ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function getScheduledTaskForWorkspace(scheduledTaskId: string, workspaceId: string) {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("scheduled_task")
    .select(SCHEDULED_TASK_SELECT)
    .eq("id", scheduledTaskId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("scheduled_task query", error);
  if (!data?.agent_id) throw new ApiRouteError(404, "scheduled_task_not_found", "Scheduled task was not found");
  await assertAgentInWorkspace(data.agent_id, workspaceId);
  return data;
}

function schedulePersistenceFields(
  args: Record<string, unknown>,
): Pick<TablesInsert<"scheduled_task">, "cron_schedule" | "next_interval" | "start_time"> {
  const schedule = scheduleArg(args);
  const cronSchedule =
    stringArg(args, "cronSchedule") ||
    stringArg(args, "cron_schedule") ||
    (schedule?.kind === "cron" ? String(schedule.expression ?? "").trim() : "");
  const startTime =
    stringArg(args, "startTime") ||
    stringArg(args, "start_time") ||
    (schedule?.kind === "at" ? String(schedule.runAt ?? "").trim() : "");
  return {
    ...(cronSchedule ? { cron_schedule: cronSchedule } : {}),
    ...(schedule ? { next_interval: schedule as Json } : {}),
    ...(startTime ? { start_time: startTime } : {}),
  };
}

export function isDatabaseTool(tool: ToolDefinition): boolean {
  return tool.executionKind === "database";
}

export async function executeDatabaseTool(
  tool: ToolDefinition,
  argumentsValue: unknown,
  context?: ToolExecutionContext,
): Promise<DatabaseToolResult> {
  const args = asRecord(argumentsValue);
  const requestedWorkspaceId = stringArg(args, "workspace_id") || stringArg(args, "workspaceId");
  const workspaceId = context?.workspaceId?.trim() || "";
  if (!workspaceId) {
    throw new ApiRouteError(400, "runtime_context_required", "workspace_id is required in runtime context");
  }
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceId) {
    throw new ApiRouteError(403, "workspace_mismatch", "Tool workspace_id must match the runtime workspace");
  }

  switch (toolKey(tool)) {
    case "plans.read":
    case "get_plans": {
      const limit = optionalPositiveInteger(args, "limit", 50, 200);
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase
        .from("plan")
        .select("id,workspace_id,name,description,type,status,is_ongoing,created_at,updated_at")
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw normalizeSupabaseError("plan query", error);
      return { status: 200, output: jsonOutput({ plans: data ?? [] }) };
    }

    case "plan.read": {
      const planId = stringArg(args, "plan_id") || stringArg(args, "planId");
      if (!planId) {
        throw new ApiRouteError(400, "invalid_tool_arguments", "plan_id is required");
      }
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase
        .from("plan")
        .select("id,workspace_id,name,description,type,status,is_ongoing,created_at,updated_at")
        .eq("workspace_id", workspaceId)
        .eq("id", planId)
        .limit(1)
        .maybeSingle();
      if (error) throw normalizeSupabaseError("plan query", error);
      if (!data) throw new ApiRouteError(404, "plan_not_found", "Plan was not found");
      return { status: 200, output: jsonOutput({ plan: data }) };
    }

    case "plan.delete": {
      const planId = stringArg(args, "plan_id") || stringArg(args, "planId");
      if (!planId) {
        throw new ApiRouteError(400, "invalid_tool_arguments", "plan_id is required");
      }
      const result = await deletePlanForWorkspace(workspaceId, planId);
      return { status: 200, output: jsonOutput(result) };
    }

    case "plan.create": {
      const name = stringArg(args, "name");
      if (!name) {
        throw new ApiRouteError(400, "invalid_tool_arguments", "name is required");
      }
      const payload = {
        workspace_id: workspaceId,
        name,
        description: stringArg(args, "description") || null,
        type: stringArg(args, "type") || null,
        is_ongoing: typeof args.is_ongoing === "boolean" ? args.is_ongoing : null,
      };
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase
        .from("plan")
        .insert(payload)
        .select("id,workspace_id,name,description,type,status,is_ongoing,created_at,updated_at")
        .single();
      if (error) throw normalizeSupabaseError("plan insert", error);
      return { status: 201, output: jsonOutput({ plan: data }) };
    }

    case "scheduled_task.list": {
      const agentId = stringArg(args, "agentId") || stringArg(args, "agent_id");
      const supabase = getServiceRoleSupabase();
      const agentIds = agentId ? [agentId] : await workspaceAgentIds(workspaceId);
      if (agentId) await assertAgentInWorkspace(agentId, workspaceId);
      if (agentIds.length === 0) return { status: 200, output: jsonOutput({ scheduledTasks: [] }) };
      const { data, error } = await supabase
        .from("scheduled_task")
        .select(SCHEDULED_TASK_SELECT)
        .in("agent_id", agentIds)
        .order("created_at", { ascending: false });
      if (error) throw normalizeSupabaseError("scheduled_task query", error);
      return { status: 200, output: jsonOutput({ scheduledTasks: data ?? [] }) };
    }

    case "memory.search": {
      const agentId = context?.agentId?.trim() || "";
      if (!agentId) throw new ApiRouteError(400, "runtime_context_required", "agent_id is required in runtime context");
      const learningEnabled = await isLearningEnabledForAgent({
        agentId,
        workspaceId,
        supabase: getServiceRoleSupabase(),
      });
      if (!learningEnabled) {
        throw new ApiRouteError(403, "learning_disabled", "Workspace learning is not enabled for this agent");
      }
      const query = stringArg(args, "query");
      if (!query) throw new ApiRouteError(400, "invalid_tool_arguments", "query is required");
      const scope = stringArg(args, "scope") || undefined;
      const importanceMin = optionalPositiveInteger(args, "importance_min", 1, 10);
      const limit = optionalPositiveInteger(args, "limit", 5, 20);
      const retrieval = await retrieveRelevantMemories({
        workspaceId,
        agentId,
        queryText: query,
        scope: scope === "workspace" || scope === "agent" ? scope : undefined,
        importanceMin,
        limit,
        maxTokens: 1200,
      });
      const results = retrieval.results;
      return {
        status: 200,
        output: jsonOutput({
          results,
          resultCount: results.length,
          resultTokenCount: memoryResultTokenCount(results),
          embeddingUsed: retrieval.embeddingUsed,
        }),
      };
    }

    case "tool_examples.append": {
      return appendToolExamples(args, workspaceId, context);
    }

    case "scheduled_task.read": {
      const scheduledTaskId = scheduledTaskIdArg(args);
      if (!scheduledTaskId) throw new ApiRouteError(400, "invalid_tool_arguments", "scheduledTaskId is required");
      const scheduledTask = await getScheduledTaskForWorkspace(scheduledTaskId, workspaceId);
      return { status: 200, output: jsonOutput({ scheduledTask }) };
    }

    case "scheduled_task.create": {
      const agentId = stringArg(args, "agentId") || stringArg(args, "agent_id") || context?.agentId?.trim() || "";
      const instructions = stringArg(args, "instructions");
      if (!agentId) throw new ApiRouteError(400, "invalid_tool_arguments", "agentId is required");
      if (!instructions) throw new ApiRouteError(400, "invalid_tool_arguments", "instructions is required");
      await assertAgentInWorkspace(agentId, workspaceId);
      const supabase = getServiceRoleSupabase();
      const insert: TablesInsert<"scheduled_task"> = {
        agent_id: agentId,
        instructions,
        is_active: booleanArg(args, "enabled") ?? booleanArg(args, "is_active") ?? true,
        is_completed: false,
        is_follow_up: booleanArg(args, "isFollowUp") ?? booleanArg(args, "is_follow_up") ?? false,
        ...schedulePersistenceFields(args),
      };
      const { data, error } = await supabase
        .from("scheduled_task")
        .insert(insert)
        .select(SCHEDULED_TASK_SELECT)
        .single();
      if (error) throw normalizeSupabaseError("scheduled_task insert", error);
      return { status: 201, output: jsonOutput({ scheduledTask: data }) };
    }

    case "scheduled_task.update": {
      const scheduledTaskId = scheduledTaskIdArg(args);
      if (!scheduledTaskId) throw new ApiRouteError(400, "invalid_tool_arguments", "scheduledTaskId is required");
      await getScheduledTaskForWorkspace(scheduledTaskId, workspaceId);
      const update: TablesUpdate<"scheduled_task"> = {
        updated_at: new Date().toISOString(),
        ...schedulePersistenceFields(args),
      };
      const instructions = stringArg(args, "instructions");
      const enabled = booleanArg(args, "enabled") ?? booleanArg(args, "is_active");
      if (instructions) update.instructions = instructions;
      if (enabled !== null) update.is_active = enabled;
      const isCompleted = booleanArg(args, "isCompleted") ?? booleanArg(args, "is_completed");
      if (isCompleted !== null) update.is_completed = isCompleted;
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase
        .from("scheduled_task")
        .update(update)
        .eq("id", scheduledTaskId)
        .select(SCHEDULED_TASK_SELECT)
        .single();
      if (error) throw normalizeSupabaseError("scheduled_task update", error);
      return { status: 200, output: jsonOutput({ scheduledTask: data }) };
    }

    case "scheduled_task.delete": {
      const scheduledTaskId = scheduledTaskIdArg(args);
      if (!scheduledTaskId) throw new ApiRouteError(400, "invalid_tool_arguments", "scheduledTaskId is required");
      await getScheduledTaskForWorkspace(scheduledTaskId, workspaceId);
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase
        .from("scheduled_task")
        .update({
          is_active: false,
          is_completed: true,
          cancelled_reason: stringArg(args, "reason") || "Canceled by scheduled_task.delete",
          updated_at: new Date().toISOString(),
        })
        .eq("id", scheduledTaskId)
        .select(SCHEDULED_TASK_SELECT)
        .single();
      if (error) throw normalizeSupabaseError("scheduled_task cancel", error);
      return { status: 200, output: jsonOutput({ scheduledTask: data }) };
    }

    default:
      throw new ApiRouteError(400, "unsupported_database_tool", `Unsupported database tool: ${toolKey(tool)}`);
  }
}
