import { ModelSettingsSchema } from "../../../../../contracts/agents.js";
import { ApiRouteError } from "../../http.js";
import { getServiceRoleSupabase, getUserScopedSupabase, normalizeSupabaseError } from "../../supabase-client.js";
import { hasCredentialForAgent } from "../credentials/agent-scope.js";
import type {
  AgentProfileRow,
  CredentialAliasRow,
  CredentialProfileRow,
  GatewayConfigProfileRow,
  ResolveExecutionProfileInput,
  RoutingRuleMatchRow,
  RoutingRuleRow,
} from "./types.js";

type CredentialQueryClient = {
  from(table: "credential"): {
    select(columns: string): {
      eq(column: string, value: unknown): PromiseLike<{ data: unknown; error: never }>;
    };
  };
};

function clientForAccessToken(accessToken?: string) {
  return accessToken ? getUserScopedSupabase(accessToken) : getServiceRoleSupabase();
}

export async function getAgent(input: ResolveExecutionProfileInput): Promise<AgentProfileRow> {
  const { data, error } = await clientForAccessToken(input.accessToken)
    .from("agent")
    .select("id,workspace_id,type,model_settings,tool_policy")
    .eq("id", input.agentId)
    .limit(1);
  if (error) throw normalizeSupabaseError("agent query", error);

  const agent = (data ?? [])[0] as AgentProfileRow | undefined;
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }
  return agent;
}

export async function getAgentGatewayConfig(
  input: ResolveExecutionProfileInput,
): Promise<GatewayConfigProfileRow | null> {
  const { data, error } = await clientForAccessToken(input.accessToken)
    .from("gateway_config")
    .select("config_json")
    .eq("scope_type", "agent")
    .eq("scope_id", input.agentId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw normalizeSupabaseError("gateway_config query", error);

  return ((data ?? [])[0] as GatewayConfigProfileRow | undefined) ?? null;
}

async function getRoutingRules(workspaceId: string, accessToken?: string): Promise<RoutingRuleRow[]> {
  const { data, error } = await clientForAccessToken(accessToken)
    .from("routing_rule")
    .select("id,workspace_id,priority,runner_kind,provider,model,credential_id,credential_alias,next_fallback_rule_id")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw normalizeSupabaseError("routing_rule query", error);

  return ((data ?? []) as RoutingRuleRow[]).sort((left, right) => right.priority - left.priority);
}

export async function getRoutingRulesWithFallback(
  workspaceId: string,
  accessToken?: string,
): Promise<RoutingRuleRow[]> {
  try {
    return await getRoutingRules(workspaceId, accessToken);
  } catch {
    return [];
  }
}

async function getRuleMatches(
  workspaceId: string,
  ruleIds: string[],
  accessToken?: string,
): Promise<RoutingRuleMatchRow[]> {
  if (ruleIds.length === 0) return [];
  const { data, error } = await clientForAccessToken(accessToken)
    .from("routing_rule_match")
    .select("rule_id,kind,key,value")
    .eq("workspace_id", workspaceId)
    .in("rule_id", ruleIds);
  if (error) throw normalizeSupabaseError("routing_rule_match query", error);

  return (data ?? []) as RoutingRuleMatchRow[];
}

export async function getRuleMatchesWithFallback(
  workspaceId: string,
  ruleIds: string[],
  accessToken?: string,
): Promise<RoutingRuleMatchRow[]> {
  try {
    return await getRuleMatches(workspaceId, ruleIds, accessToken);
  } catch {
    return [];
  }
}

export async function resolveCredentialAlias(
  workspaceId: string,
  alias: string,
  accessToken?: string,
): Promise<string | null> {
  const { data, error } = await clientForAccessToken(accessToken)
    .from("credential_alias")
    .select("alias,credential_id")
    .eq("workspace_id", workspaceId)
    .eq("alias", alias)
    .limit(1);
  if (error) throw normalizeSupabaseError("credential_alias query", error);

  const match = (data ?? [])[0] as CredentialAliasRow | undefined;
  return match?.credential_id ?? null;
}

export async function getAgentCredentialId(
  agentId: string,
  workspaceId: string | null,
  accessToken?: string,
): Promise<string | null> {
  if (!workspaceId) return null;
  const { data, error } = await (clientForAccessToken(accessToken) as unknown as CredentialQueryClient)
    .from("credential")
    .select("id,key_value")
    .eq("workspace_id", workspaceId);
  if (error) throw normalizeSupabaseError("credential query", error);

  const rows = (data ?? []) as CredentialProfileRow[];
  const match = rows.find((row) => {
    const value = row.key_value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return (value as { agent_id?: unknown }).agent_id === agentId;
  });
  return match?.id ?? null;
}

export async function hasScopedCredential(
  input: ResolveExecutionProfileInput,
  agent: AgentProfileRow,
): Promise<boolean> {
  if (input.skipCredentialCheck) return true;
  if (!input.requesterUserId) return false;
  return hasCredentialForAgent(input.accessToken ?? "", input.requesterUserId, {
    ...agent,
    model_settings: ModelSettingsSchema.parse(agent.model_settings),
  });
}
