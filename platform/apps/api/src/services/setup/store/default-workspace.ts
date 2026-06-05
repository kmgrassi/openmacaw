import { ApiRouteError } from "../../../http.js";
import { getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { getSetupDefaults } from "../defaults.js";
import type { WorkspaceMemberRow, WorkspaceRow } from "../types.js";
import { WORKSPACE_MEMBER_SELECT, WORKSPACE_SELECT } from "./selects.js";

export async function listWorkspaceMemberships(accessToken: string, userId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("workspace_members")
    .select(WORKSPACE_MEMBER_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw normalizeSupabaseError("workspace_members query", error);
  return data as WorkspaceMemberRow[];
}

async function listUserWorkspaces(accessToken: string, userId: string) {
  const memberships = await listWorkspaceMemberships(accessToken, userId);
  if (memberships.length === 0) return [];

  const ids = memberships.map((membership) => membership.workspace_id);
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("workspaces")
    .select(WORKSPACE_SELECT)
    .in("id", ids);

  if (error) throw normalizeSupabaseError("workspaces query", error);
  const workspaces = data as WorkspaceRow[];

  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  return memberships.map((membership) => workspaceById.get(membership.workspace_id)).filter(Boolean) as WorkspaceRow[];
}

export async function ensureDefaultWorkspace(accessToken: string, userId: string) {
  const setupDefaults = getSetupDefaults();
  const existing = await listUserWorkspaces(accessToken, userId);
  if (existing[0]) return { workspace: existing[0], workspaces: existing };

  const supabase = getUserScopedSupabase(accessToken);
  const { data: workspaceIdResult, error: workspaceCreateError } = await supabase.rpc(
    "ensure_default_workspace_for_user" as never,
    {
      p_user_id: userId,
      p_workspace_name: setupDefaults.workspaceName,
    } as never,
  );
  if (workspaceCreateError) throw normalizeSupabaseError("default workspace bootstrap", workspaceCreateError);
  const workspaceId: unknown = workspaceIdResult;
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new ApiRouteError(502, "workspace_bootstrap_failed", "Default workspace bootstrap returned no workspace ID");
  }

  const { data: workspaceRows, error: workspaceQueryError } = await supabase
    .from("workspaces")
    .select(WORKSPACE_SELECT)
    .eq("id", workspaceId)
    .limit(1);
  if (workspaceQueryError) throw normalizeSupabaseError("workspaces query", workspaceQueryError);
  const workspace = workspaceRows[0] as WorkspaceRow | undefined;
  if (!workspace) {
    throw new ApiRouteError(502, "workspace_bootstrap_failed", "Default workspace bootstrap returned no visible row");
  }

  return {
    workspace,
    workspaces: [workspace, ...(await listUserWorkspaces(accessToken, userId))].filter(
      (candidate, index, all) => all.findIndex((workspace) => workspace.id === candidate.id) === index,
    ),
  };
}
