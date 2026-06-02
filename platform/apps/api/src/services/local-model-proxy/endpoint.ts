import { getServiceRoleSupabase } from "../../supabase-client.js";

const DEFAULT_LOCAL_ENDPOINT = "http://localhost:11434/v1";

/**
 * Look up the model endpoint URL stored on this agent's selected routing rule.
 * Falls back to the default Ollama endpoint if nothing is stored.
 */
export async function resolveLocalEndpoint(workspaceId: string, routingRuleId: string | null): Promise<string> {
  if (!routingRuleId) return DEFAULT_LOCAL_ENDPOINT;

  const supabase = getServiceRoleSupabase();

  const { data: endpointMatch } = await supabase
    .from("routing_rule_match")
    .select("value")
    .eq("workspace_id", workspaceId)
    .eq("rule_id", routingRuleId)
    .eq("kind", "local_endpoint")
    .eq("key", "url")
    .limit(1)
    .maybeSingle();

  const endpoint = typeof endpointMatch?.value === "string" ? endpointMatch.value.trim() : "";
  if (endpoint) {
    return endpoint;
  }

  return DEFAULT_LOCAL_ENDPOINT;
}

export async function resolveLocalWorkspaceRoot(
  workspaceId: string,
  routingRuleId: string | null,
): Promise<string | null> {
  if (!routingRuleId) return null;

  const supabase = getServiceRoleSupabase();
  const { data: rootMatch } = await supabase
    .from("routing_rule_match")
    .select("value")
    .eq("workspace_id", workspaceId)
    .eq("rule_id", routingRuleId)
    .eq("kind", "local_workspace_root")
    .eq("key", "path")
    .limit(1)
    .maybeSingle();

  const workspaceRoot = typeof rootMatch?.value === "string" ? rootMatch.value.trim() : "";
  return workspaceRoot || null;
}
