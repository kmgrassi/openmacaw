import { ApiRouteError } from "../../../http.js";
import { getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { getSetupDefaults } from "../defaults.js";
import { personalWorkspaceId } from "../identity.js";
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

  const { data: workspaceRows, error: workspaceError } = await getUserScopedSupabase(accessToken)
    .from("workspaces")
    .upsert(
      {
        id: personalWorkspaceId(userId),
        name: setupDefaults.workspaceName,
        owner_user_id: userId,
      },
      { onConflict: "id" },
    )
    .select(WORKSPACE_SELECT);
  if (workspaceError) throw normalizeSupabaseError("workspaces upsert", workspaceError);
  const workspace = workspaceRows[0] as WorkspaceRow | undefined;
  if (!workspace) {
    throw new ApiRouteError(502, "workspace_upsert_failed", "Workspace upsert returned no row");
  }

  const { error: membershipError } = await getUserScopedSupabase(accessToken)
    .from("workspace_members")
    .upsert(
      {
        workspace_id: workspace.id,
        user_id: userId,
        role: setupDefaults.workspaceMemberRole,
      },
      { onConflict: "workspace_id,user_id" },
    )
    .select(WORKSPACE_MEMBER_SELECT);
  if (membershipError) throw normalizeSupabaseError("workspace_members upsert", membershipError);

  return {
    workspace,
    workspaces: [workspace, ...(await listUserWorkspaces(accessToken, userId))].filter(
      (candidate, index, all) => all.findIndex((workspace) => workspace.id === candidate.id) === index,
    ),
  };
}
