import type { Json, TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";

import { ApiRouteError } from "../http.js";
import { narrowSupabase, type NarrowSupabaseQuery } from "../lib/narrow-supabase.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { ROUTING_RULE_PROVIDER_ALLOWED } from "../repositories/routing-rules.js";
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
const ROUTING_RULE_SELECT =
  "id,workspace_id,name,priority,runner_kind,provider,model,credential_id,credential_alias,enabled,model_tier_floor,updated_at" as const;
const ROUTING_RULE_FALLBACK_SELECT =
  "id,workspace_id,routing_rule_id,position,provider,model,credential_id,credential_alias,created_at,updated_at" as const;
const ROUTING_RULE_CHANGE_SELECT =
  "id,workspace_id,routing_rule_id,actor_agent_id,change_kind,old_provider,old_model,new_provider,new_model,reason,created_at" as const;

type RoutingRuleToolRow = {
  id: string;
  workspace_id: string;
  name: string;
  priority: number;
  runner_kind: string;
  provider: string | null;
  model: string | null;
  credential_id: string | null;
  credential_alias: string | null;
  enabled: boolean;
  model_tier_floor?: string | null;
  updated_at: string;
};

type RoutingRuleFallbackRow = {
  id: string;
  workspace_id: string;
  routing_rule_id: string;
  position: number;
  provider: string;
  model: string;
  credential_id: string | null;
  credential_alias: string | null;
  created_at: string;
  updated_at: string;
};

type CredentialRefArg = {
  type: "credential_id" | "alias";
  value: string;
};

type FallbackArg = {
  provider: string;
  model: string;
  credentialRef: CredentialRefArg | null;
};

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

function queryFrom<Row = Record<string, unknown>>(table: string): NarrowSupabaseQuery<Row> {
  return narrowSupabase(getServiceRoleSupabase()).from<Row>(table);
}

function missingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "PGRST204" ||
    code === "PGRST205" ||
    code === "42703" ||
    message.includes("PGRST204") ||
    message.includes("PGRST205") ||
    message.includes("42703") ||
    message.includes("Could not find") ||
    message.includes("schema cache")
  );
}

async function executeRouterRows<Row>(
  context: string,
  query: PromiseLike<{ data: unknown; error: unknown | null }>,
): Promise<Row[]> {
  try {
    const { data, error } = await query;
    if (error) throw normalizeSupabaseError(context, error as never);
    if (!data) return [];
    return (Array.isArray(data) ? data : [data]) as Row[];
  } catch (error) {
    if (missingSchema(error)) {
      throw new ApiRouteError(
        503,
        "routing_tool_schema_unavailable",
        "Routing tools require the intelligent cutover routing schema migrations before they can be used",
        { context },
      );
    }
    throw error;
  }
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

function credentialRefArg(value: unknown): CredentialRefArg | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = record.type;
  const refValue = typeof record.value === "string" ? record.value.trim() : "";
  if ((type === "credential_id" || type === "alias") && refValue) return { type, value: refValue };
  throw new ApiRouteError(400, "invalid_tool_arguments", "credentialRef must include type and value");
}

function fallbackArgs(value: unknown): FallbackArg[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new ApiRouteError(400, "invalid_tool_arguments", "fallbacks must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiRouteError(400, "invalid_tool_arguments", `fallbacks[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider.trim() : "";
    const model = typeof record.model === "string" ? record.model.trim() : "";
    assertKnownProviderModel(provider, model);
    return { provider, model, credentialRef: credentialRefArg(record.credentialRef ?? record.credential_ref) };
  });
}

function assertKnownProviderModel(provider: string, model: string) {
  if (!provider || !model) {
    throw new ApiRouteError(400, "unknown_model_in_fallback_chain", "provider and model are required");
  }
  if (!ROUTING_RULE_PROVIDER_ALLOWED.has(provider)) {
    throw new ApiRouteError(400, "unknown_model_in_fallback_chain", `Unknown execution provider: ${provider}`);
  }
}

function routingRuleIdArg(args: Record<string, unknown>): string {
  return stringArg(args, "routingRuleId") || stringArg(args, "routing_rule_id") || stringArg(args, "id");
}

function publicRoutingRule(rule: RoutingRuleToolRow, fallbacks: RoutingRuleFallbackRow[]) {
  return {
    id: rule.id,
    workspaceId: rule.workspace_id,
    name: rule.name,
    priority: rule.priority,
    runnerKind: rule.runner_kind,
    provider: rule.provider,
    model: rule.model,
    credentialRef: rule.credential_alias
      ? { type: "alias", value: rule.credential_alias }
      : rule.credential_id
        ? { type: "credential_id", value: rule.credential_id }
        : null,
    enabled: rule.enabled,
    modelTierFloor: rule.model_tier_floor ?? "any",
    fallbacks: fallbacks.map((fallback) => ({
      id: fallback.id,
      position: fallback.position,
      provider: fallback.provider,
      model: fallback.model,
      credentialRef: fallback.credential_alias
        ? { type: "alias", value: fallback.credential_alias }
        : fallback.credential_id
          ? { type: "credential_id", value: fallback.credential_id }
          : null,
    })),
    updatedAt: rule.updated_at,
  };
}

async function listRoutingRuleFallbacks(ruleIds: string[], workspaceId: string): Promise<RoutingRuleFallbackRow[]> {
  if (ruleIds.length === 0) return [];
  return executeRouterRows<RoutingRuleFallbackRow>(
    "routing_rule_fallback query",
    queryFrom("routing_rule_fallback")
      .select(ROUTING_RULE_FALLBACK_SELECT)
      .eq("workspace_id", workspaceId)
      .in("routing_rule_id", ruleIds)
      .order("position", { ascending: true }),
  );
}

async function readRoutingRule(routingRuleId: string, workspaceId: string): Promise<RoutingRuleToolRow> {
  const rows = await executeRouterRows<RoutingRuleToolRow>(
    "routing_rule query",
    queryFrom("routing_rule")
      .select(ROUTING_RULE_SELECT)
      .eq("workspace_id", workspaceId)
      .eq("id", routingRuleId)
      .limit(1),
  );
  const rule = rows[0] ?? null;
  if (!rule) throw new ApiRouteError(404, "routing_rule_not_found", "Routing rule was not found");
  return rule;
}

async function isActorRule(routingRuleId: string, workspaceId: string, agentId: string): Promise<boolean> {
  const matches = await executeRouterRows<{ kind: string | null; key: string | null; value: string | null }>(
    "routing_rule_match query",
    queryFrom("routing_rule_match")
      .select("kind,key,value")
      .eq("workspace_id", workspaceId)
      .eq("rule_id", routingRuleId)
      .eq("value", agentId),
  );
  return matches.some(
    (match) =>
      (match.kind === "agent" && match.key === "id") ||
      (match.kind === "agent_id" && (match.key === "id" || match.key === "agent_id")),
  );
}

async function insertRoutingRuleChange(input: {
  workspaceId: string;
  routingRuleId: string;
  actorAgentId: string | null;
  changeKind: "primary_model" | "fallback_chain" | "enabled";
  oldProvider?: string | null;
  oldModel?: string | null;
  newProvider?: string | null;
  newModel?: string | null;
  reason: string;
}) {
  await executeRouterRows(
    "routing_rule_change insert",
    queryFrom("routing_rule_change")
      .insert({
        workspace_id: input.workspaceId,
        routing_rule_id: input.routingRuleId,
        actor_agent_id: input.actorAgentId,
        change_kind: input.changeKind,
        old_provider: input.oldProvider ?? null,
        old_model: input.oldModel ?? null,
        new_provider: input.newProvider ?? null,
        new_model: input.newModel ?? null,
        reason: input.reason,
      })
      .select(ROUTING_RULE_CHANGE_SELECT),
  );
}

async function replaceRoutingRuleFallbacks(input: {
  workspaceId: string;
  routingRuleId: string;
  fallbacks: FallbackArg[];
}) {
  await executeRouterRows(
    "routing_rule_fallback delete",
    queryFrom("routing_rule_fallback")
      .delete()
      .eq("workspace_id", input.workspaceId)
      .eq("routing_rule_id", input.routingRuleId),
  );
  if (input.fallbacks.length === 0) return;
  await executeRouterRows(
    "routing_rule_fallback insert",
    queryFrom("routing_rule_fallback")
      .insert(
        input.fallbacks.map((fallback, position) => ({
          workspace_id: input.workspaceId,
          routing_rule_id: input.routingRuleId,
          position,
          provider: fallback.provider,
          model: fallback.model,
          credential_id: fallback.credentialRef?.type === "credential_id" ? fallback.credentialRef.value : null,
          credential_alias: fallback.credentialRef?.type === "alias" ? fallback.credentialRef.value : null,
        })),
      )
      .select(ROUTING_RULE_FALLBACK_SELECT),
  );
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

    case "routing_rule.list": {
      const limit = optionalPositiveInteger(args, "limit", 50, 200);
      const rules = await executeRouterRows<RoutingRuleToolRow>(
        "routing_rule query",
        queryFrom("routing_rule")
          .select(ROUTING_RULE_SELECT)
          .eq("workspace_id", workspaceId)
          .order("priority", { ascending: true })
          .limit(limit),
      );
      const fallbacks = await listRoutingRuleFallbacks(
        rules.map((rule) => rule.id),
        workspaceId,
      );
      const fallbacksByRule = new Map<string, RoutingRuleFallbackRow[]>();
      for (const fallback of fallbacks) {
        const current = fallbacksByRule.get(fallback.routing_rule_id) ?? [];
        current.push(fallback);
        fallbacksByRule.set(fallback.routing_rule_id, current);
      }
      return {
        status: 200,
        output: jsonOutput({
          routingRules: rules.map((rule) => publicRoutingRule(rule, fallbacksByRule.get(rule.id) ?? [])),
        }),
      };
    }

    case "routing_rule.read": {
      const routingRuleId = routingRuleIdArg(args);
      if (!routingRuleId) throw new ApiRouteError(400, "invalid_tool_arguments", "routingRuleId is required");
      const rule = await readRoutingRule(routingRuleId, workspaceId);
      const fallbacks = await listRoutingRuleFallbacks([routingRuleId], workspaceId);
      return { status: 200, output: jsonOutput({ routingRule: publicRoutingRule(rule, fallbacks) }) };
    }

    case "routing_rule.update": {
      const routingRuleId = routingRuleIdArg(args);
      if (!routingRuleId) throw new ApiRouteError(400, "invalid_tool_arguments", "routingRuleId is required");
      if (args.modelTierFloor !== undefined || args.model_tier_floor !== undefined) {
        throw new ApiRouteError(
          400,
          "model_tier_floor_user_owned",
          "routing_rule.update cannot modify model_tier_floor; users own that policy field",
        );
      }
      const reason = stringArg(args, "reason");
      if (!reason) throw new ApiRouteError(400, "missing_reason", "reason is required for routing_rule.update");

      const existing = await readRoutingRule(routingRuleId, workspaceId);
      const previousPrimary = { provider: existing.provider, model: existing.model, enabled: existing.enabled };
      const existingFallbacks = await listRoutingRuleFallbacks([routingRuleId], workspaceId);
      const actorAgentId = context?.agentId?.trim() || null;
      const actorOwnsRule = actorAgentId ? await isActorRule(routingRuleId, workspaceId, actorAgentId) : false;
      const requestedEnabled = booleanArg(args, "enabled");
      if (actorOwnsRule && requestedEnabled === false) {
        throw new ApiRouteError(400, "self_brick_update", "Agents cannot disable their own routing rule");
      }

      const provider = stringArg(args, "provider");
      const model = stringArg(args, "model");
      const hasCredentialUpdate = args.credentialRef !== undefined || args.credential_ref !== undefined;
      const hasPrimaryUpdate = provider.length > 0 || model.length > 0 || hasCredentialUpdate;
      const fallbacks = fallbackArgs(args.fallbacks);
      const nextProvider = provider || existing.provider || "";
      const nextModel = model || existing.model || "";
      if (hasPrimaryUpdate) assertKnownProviderModel(nextProvider, nextModel);
      if (actorOwnsRule && requestedEnabled !== true && !existing.enabled) {
        throw new ApiRouteError(400, "self_brick_update", "Agents cannot leave their own routing rule disabled");
      }
      const nextFallbackCount = fallbacks === null ? existingFallbacks.length : fallbacks.length;
      if (actorOwnsRule && (!nextProvider || !nextModel) && nextFallbackCount === 0) {
        throw new ApiRouteError(
          400,
          "self_brick_update",
          "Agents cannot leave their own routing rule with zero resolvable links",
        );
      }

      const credentialRef = credentialRefArg(args.credentialRef ?? args.credential_ref);
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (hasPrimaryUpdate) {
        update.provider = nextProvider;
        update.model = nextModel;
        if (hasCredentialUpdate) {
          update.credential_id = credentialRef?.type === "credential_id" ? credentialRef.value : null;
          update.credential_alias = credentialRef?.type === "alias" ? credentialRef.value : null;
        }
      }
      if (requestedEnabled !== null) update.enabled = requestedEnabled;

      const updatedRows =
        Object.keys(update).length > 1
          ? await executeRouterRows<RoutingRuleToolRow>(
              "routing_rule update",
              queryFrom("routing_rule")
                .update(update)
                .eq("id", routingRuleId)
                .eq("workspace_id", workspaceId)
                .select(ROUTING_RULE_SELECT),
            )
          : [existing];
      const updated = updatedRows[0] ?? existing;

      if (fallbacks !== null) {
        await replaceRoutingRuleFallbacks({ workspaceId, routingRuleId, fallbacks });
      }

      if (
        hasPrimaryUpdate &&
        (previousPrimary.provider !== updated.provider || previousPrimary.model !== updated.model)
      ) {
        await insertRoutingRuleChange({
          workspaceId,
          routingRuleId,
          actorAgentId,
          changeKind: "primary_model",
          oldProvider: previousPrimary.provider,
          oldModel: previousPrimary.model,
          newProvider: updated.provider,
          newModel: updated.model,
          reason,
        });
      }
      if (fallbacks !== null) {
        await insertRoutingRuleChange({
          workspaceId,
          routingRuleId,
          actorAgentId,
          changeKind: "fallback_chain",
          oldProvider: existingFallbacks[0]?.provider ?? null,
          oldModel: existingFallbacks[0]?.model ?? null,
          newProvider: fallbacks[0]?.provider ?? null,
          newModel: fallbacks[0]?.model ?? null,
          reason,
        });
      }
      if (requestedEnabled !== null && previousPrimary.enabled !== requestedEnabled) {
        await insertRoutingRuleChange({
          workspaceId,
          routingRuleId,
          actorAgentId,
          changeKind: "enabled",
          oldProvider: previousPrimary.provider,
          oldModel: previousPrimary.model,
          newProvider: updated.provider,
          newModel: updated.model,
          reason,
        });
      }

      const updatedFallbacks = await listRoutingRuleFallbacks([routingRuleId], workspaceId);
      return { status: 200, output: jsonOutput({ routingRule: publicRoutingRule(updated, updatedFallbacks) }) };
    }

    case "local_model.list": {
      const machines = await executeRouterRows<Record<string, unknown>>(
        "local_runtime_machine query",
        queryFrom("local_runtime_machine")
          .select(
            "id,workspace_id,display_name,helper_version,runner_kinds,advertised_runner_kinds,last_seen_at,revoked_at,updated_at",
          )
          .eq("workspace_id", workspaceId)
          .is("revoked_at", null)
          .order("updated_at", { ascending: false }),
      );
      const machineIds = machines.map((machine) => String(machine.id ?? "")).filter(Boolean);
      const models =
        machineIds.length > 0
          ? await executeRouterRows<Record<string, unknown>>(
              "local_runtime_model query",
              queryFrom("local_runtime_model")
                .select("id,machine_id,runner_kind,model,metadata,created_at,updated_at")
                .in("machine_id", machineIds)
                .order("updated_at", { ascending: false }),
            )
          : [];
      return { status: 200, output: jsonOutput({ machines, models }) };
    }

    case "provider_cutover.list": {
      const limit = optionalPositiveInteger(args, "limit", 25, 100);
      const cutovers = await executeRouterRows<Record<string, unknown>>(
        "provider_cutover query",
        queryFrom("provider_cutover")
          .select("*")
          .eq("workspace_id", workspaceId)
          .order("triggered_at", { ascending: false })
          .limit(limit),
      );
      return { status: 200, output: jsonOutput({ providerCutovers: cutovers }) };
    }

    case "provider_failure.list": {
      const limit = optionalPositiveInteger(args, "limit", 25, 100);
      const failures = await executeRouterRows<Record<string, unknown>>(
        "provider_failure query",
        queryFrom("provider_failure")
          .select("*")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .limit(limit),
      );
      return { status: 200, output: jsonOutput({ providerFailures: failures }) };
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
