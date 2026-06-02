import { getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { countCredentialsForAgent } from "../../credentials/agent-scope.js";
import {
  ENGINE_INSTANCE_SELECT,
  GATEWAY_CONFIG_SELECT,
  GATEWAY_CONFIG_STATE_SELECT,
  WORKSPACE_SELECT,
} from "./selects.js";
import type { AgentRow, EngineInstanceRow, GatewayConfigRow, GatewayConfigStateRow, WorkspaceRow } from "../types.js";

export async function getLatestEngine(accessToken: string, agentId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("engine_instance")
    .select(ENGINE_INSTANCE_SELECT)
    .eq("agent_id", agentId)
    .order("started_at", { ascending: false })
    .limit(1);

  if (error) throw normalizeSupabaseError("engine_instance query", error);
  return (data[0] as EngineInstanceRow | undefined) ?? null;
}

export async function getGatewayConfig(accessToken: string, agentId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("gateway_config")
    .select(GATEWAY_CONFIG_SELECT)
    .eq("scope_type", "agent")
    .eq("scope_id", agentId)
    .limit(1);

  if (error) throw normalizeSupabaseError("gateway_config query", error);
  return (data[0] as GatewayConfigRow | undefined) ?? null;
}

export async function getAgentCredentialCount(accessToken: string, requesterUserId: string, agent: AgentRow) {
  // Delegates to the shared OQ-04 schema-compat helper. See
  // `services/credentials/agent-scope.ts` for the model.
  return countCredentialsForAgent(accessToken, requesterUserId, agent);
}

export async function getGatewayConfigState(accessToken: string, agentId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("gateway_config_state")
    .select(GATEWAY_CONFIG_STATE_SELECT)
    .eq("scope_type", "agent")
    .eq("scope_id", agentId)
    .limit(1);

  if (error) throw normalizeSupabaseError("gateway_config_state query", error);
  return (data[0] as GatewayConfigStateRow | undefined) ?? null;
}

export async function getWorkspaceById(accessToken: string, workspaceId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("workspaces")
    .select(WORKSPACE_SELECT)
    .eq("id", workspaceId)
    .limit(1);

  if (error) throw normalizeSupabaseError("workspaces query", error);
  return (data[0] as WorkspaceRow | undefined) ?? null;
}
