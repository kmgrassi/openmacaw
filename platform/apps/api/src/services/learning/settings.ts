import type { Json } from "@kmgrassi/supabase-schema";

import { normalizeSupabaseError, type ApiSupabaseClient } from "../../supabase-client.js";

type AgentWorkspaceRow = {
  id: string;
  workspace_id: string | null;
};

type WorkspaceLearningSettingsRow = {
  id: string;
  settings?: Json | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function learningEnabledFromWorkspaceSettings(settings: unknown): boolean {
  const workspaceSettings = asRecord(settings);
  const learning = asRecord(workspaceSettings.learning);
  return learning.enabled === true;
}

export async function isLearningEnabledForAgent(input: {
  agentId: string;
  workspaceId: string;
  supabase: ApiSupabaseClient;
}) {
  const { data: agentData, error: agentError } = await input.supabase
    .from("agent")
    .select("id,workspace_id")
    .eq("id", input.agentId)
    .eq("workspace_id", input.workspaceId)
    .limit(1)
    .maybeSingle();
  if (agentError) throw normalizeSupabaseError("agent workspace query", agentError);
  const agentRow = agentData as AgentWorkspaceRow | null;
  if (!agentRow) return false;

  const { data: workspaceData, error: workspaceError } = await input.supabase
    .from("workspaces")
    .select("id,settings")
    .eq("id", input.workspaceId)
    .limit(1)
    .maybeSingle();
  if (workspaceError) throw normalizeSupabaseError("workspace learning settings query", workspaceError);
  const workspaceRow = workspaceData as WorkspaceLearningSettingsRow | null;
  return workspaceRow ? learningEnabledFromWorkspaceSettings(workspaceRow.settings ?? null) : false;
}
