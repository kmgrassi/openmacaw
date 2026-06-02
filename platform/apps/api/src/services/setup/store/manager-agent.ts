import { ApiRouteError } from "../../../http.js";
import { getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { asJson, buildModelSettings, managerAgentName, managerToolPolicyDefaults } from "../builders.js";
import { getSetupDefaults } from "../defaults.js";
import { workspaceManagerAgentId } from "../identity.js";
import type { AgentRow } from "../types.js";
import { DEFAULT_AGENT_SELECT } from "./selects.js";

async function findClaimableWorkspaceManagerAgent(accessToken: string, workspaceId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .select(DEFAULT_AGENT_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("type", "manager")
    .order("updated_at", { ascending: true });

  if (error) throw normalizeSupabaseError("agent query", error);
  const agents = data as AgentRow[];
  return agents.find((agent) => agent.status === "active") ?? agents[0] ?? null;
}

function hasPrimaryModelSettings(agent: AgentRow) {
  const settings = agent.model_settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const primary = (settings as Record<string, unknown>).primary;
  return typeof primary === "string" && primary.trim().length > 0;
}

async function updateWorkspaceManagerAgent(accessToken: string, agent: AgentRow, userId: string) {
  const setupDefaults = getSetupDefaults();
  const nextModelSettings = hasPrimaryModelSettings(agent)
    ? agent.model_settings
    : asJson(buildModelSettings(setupDefaults.managerModel));
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .update({
      name: agent.name?.trim() ? agent.name : managerAgentName(),
      status: setupDefaults.agentStatus,
      model_settings: nextModelSettings,
      tool_policy: asJson(managerToolPolicyDefaults()),
      created_by_user_id: agent.created_by_user_id ?? userId,
    })
    .eq("id", agent.id)
    .select(DEFAULT_AGENT_SELECT);

  if (error) throw normalizeSupabaseError("agent update", error);
  return (data[0] as AgentRow | undefined) ?? agent;
}

async function createWorkspaceManagerAgent(accessToken: string, workspaceId: string, userId: string) {
  const setupDefaults = getSetupDefaults();
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .upsert(
      {
        id: workspaceManagerAgentId(workspaceId),
        workspace_id: workspaceId,
        created_by_user_id: userId,
        name: managerAgentName(),
        type: "manager",
        status: setupDefaults.agentStatus,
        model_settings: asJson(buildModelSettings(setupDefaults.managerModel)),
        tool_policy: asJson(managerToolPolicyDefaults()),
      },
      { onConflict: "id" },
    )
    .select(DEFAULT_AGENT_SELECT);
  if (error) throw normalizeSupabaseError("agent upsert", error);
  const agent = data[0] as AgentRow | undefined;
  if (!agent) {
    throw new ApiRouteError(502, "manager_agent_create_failed", "Manager agent creation returned no row");
  }
  return agent;
}

export async function ensureWorkspaceManagerAgent(accessToken: string, workspaceId: string, userId: string) {
  const claimableAgent = await findClaimableWorkspaceManagerAgent(accessToken, workspaceId);
  if (claimableAgent) return updateWorkspaceManagerAgent(accessToken, claimableAgent, userId);

  return createWorkspaceManagerAgent(accessToken, workspaceId, userId);
}
