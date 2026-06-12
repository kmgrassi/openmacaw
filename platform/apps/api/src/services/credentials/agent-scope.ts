// "Does this agent have a usable credential?" check (OQ-04 model).
// Credentials are shared within a workspace, matched by
// (provider, workspace_id|user_id). Single source of truth for both
// setup/store.ts#getAgentCredentialCount and
// runtime-prepare.ts#hasAgentCredential.
import { deriveProviderFromModel, extractPrimaryModel } from "../../../../../contracts/agent-helpers.js";
import type { ModelSettings } from "../../../../../contracts/agents.js";
import { normalizeCredentialProvider } from "../../../../../contracts/credentials.js";
import { narrowSupabase } from "../../lib/narrow-supabase.js";
import { executeLoggedSupabaseRows, getSupabaseForAccessToken } from "../../supabase-client.js";

type SupabaseQuery = Parameters<typeof executeLoggedSupabaseRows>[1];
type CredentialQueryBuilder = SupabaseQuery & {
  eq(column: string, value: unknown): CredentialQueryBuilder;
  limit(count: number): CredentialQueryBuilder;
  or(expression: string): CredentialQueryBuilder;
};

export type AgentScopeFields = {
  id: string;
  workspace_id: string | null;
  model_settings: ModelSettings;
};

export async function countCredentialsForAgent(
  accessToken: string,
  requesterUserId: string,
  agent: AgentScopeFields,
): Promise<number> {
  const provider = normalizeCredentialProvider(deriveProviderFromModel(extractPrimaryModel(agent.model_settings)));
  if (!provider) return 0;

  let query = narrowSupabase(getSupabaseForAccessToken(accessToken))
    .from("credential")
    .select("id")
    .eq("provider", provider)
    .limit(1) as CredentialQueryBuilder;

  const userId = requesterUserId.trim();
  const workspaceId = agent.workspace_id?.trim();

  if (userId && workspaceId) {
    query = query.or(["workspace_id.eq." + workspaceId, "user_id.eq." + userId].join(","));
  } else if (workspaceId) {
    query = query.eq("workspace_id", workspaceId);
  } else if (userId) {
    query = query.eq("user_id", userId);
  } else {
    return 0;
  }

  const rows = await executeLoggedSupabaseRows<{ id: string }>(
    {
      operation: "credentials.agent_scope.count_credentials",
      table: "credential",
    },
    query,
  );
  return rows.length;
}

export async function hasCredentialForAgent(
  accessToken: string,
  requesterUserId: string,
  agent: AgentScopeFields,
): Promise<boolean> {
  return (await countCredentialsForAgent(accessToken, requesterUserId, agent)) > 0;
}
