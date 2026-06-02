import { deriveProviderFromModel, extractPrimaryModel } from "../../../../contracts/agent-helpers.js";
import { createStoredAgentRow } from "../repositories/agents.js";
import { getServiceRoleSupabase, normalizeSupabaseError, supabaseAuthUser } from "../supabase-client.js";
import { SCHEDULED_TASK_TOOL_SLUGS } from "./tool-bundles.js";

export async function createStoredAgentInSupabase(input: {
  accessToken: string;
  name: string;
  model: string | null;
  provider: string | null;
  agentType?: "coding" | "planning" | "manager" | "custom" | null;
  workspaceId?: string | null;
}) {
  const authUser = await supabaseAuthUser(input.accessToken);
  const userId = typeof authUser.id === "string" && authUser.id.trim().length > 0 ? authUser.id.trim() : null;
  if (!userId) {
    throw new Error("Authenticated user context is required");
  }

  let workspaceId = input.workspaceId?.trim() || "";
  let shouldEnsureOwnerMembership = false;

  if (workspaceId) {
    const { data: existingMemberships, error: membershipError } = await getServiceRoleSupabase()
      .from("workspace_members")
      .select("workspace_id,user_id,role,created_at")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .limit(1);
    if (membershipError) throw normalizeSupabaseError("workspace_members query", membershipError);

    if (existingMemberships.length === 0) {
      const { data: ownedWorkspace, error: ownedWorkspaceError } = await getServiceRoleSupabase()
        .from("workspaces")
        .select("id,name,owner_user_id,created_at")
        .eq("id", workspaceId)
        .eq("owner_user_id", userId)
        .limit(1);
      if (ownedWorkspaceError) throw normalizeSupabaseError("workspaces query", ownedWorkspaceError);

      if (ownedWorkspace.length === 0) {
        throw new Error("Authenticated user is not authorized for the requested workspace");
      }

      shouldEnsureOwnerMembership = true;
    }
  } else {
    const { data: existingMemberships, error: membershipError } = await getServiceRoleSupabase()
      .from("workspace_members")
      .select("workspace_id,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1);
    if (membershipError) throw normalizeSupabaseError("workspace_members query", membershipError);

    workspaceId = existingMemberships[0]?.workspace_id ?? "";
  }

  if (!workspaceId) {
    const { data: createdWorkspaces, error: workspaceError } = await getServiceRoleSupabase()
      .from("workspaces")
      .insert({
        name: input.name.trim() || "Harper Workspace",
        owner_user_id: userId,
      })
      .select("*");
    if (workspaceError) throw normalizeSupabaseError("workspaces insert", workspaceError);

    const createdWorkspace = createdWorkspaces[0];
    workspaceId = createdWorkspace?.id ?? "";
    if (!workspaceId) {
      throw new Error("Workspace creation returned no ID");
    }

    shouldEnsureOwnerMembership = true;
  }

  if (shouldEnsureOwnerMembership) {
    const { error: upsertError } = await getServiceRoleSupabase().from("workspace_members").upsert(
      {
        workspace_id: workspaceId,
        user_id: userId,
        role: "owner",
      },
      { onConflict: "workspace_id,user_id" },
    );
    if (upsertError) throw normalizeSupabaseError("workspace_members upsert", upsertError);
  }

  const createdAgent = await createStoredAgentRow({
    name: input.name.trim() || "Harper Assistant",
    workspaceId,
    userId,
    type: input.agentType ?? "coding",
    modelSettings: input.model ? { primary: input.model } : {},
    toolPolicy:
      input.agentType === "planning"
        ? {
            planning: {
              destination: "database",
              tools: [
                "plan.create",
                "task.create",
                "task.update",
                "plan.read",
                "task.read",
                ...SCHEDULED_TASK_TOOL_SLUGS,
              ],
            },
          }
        : input.agentType === "custom"
          ? { custom: { target_required: true } }
          : {},
  });
  if (!createdAgent?.id) {
    throw new Error("Agent creation returned no ID");
  }

  return {
    id: createdAgent.id,
    workspace_id: workspaceId,
    name: createdAgent.name?.trim() || input.name.trim() || createdAgent.id,
    agent_type: createdAgent.type ?? input.agentType ?? "coding",
    model: extractPrimaryModel(createdAgent.model_settings) ?? input.model ?? null,
    provider:
      input.provider ??
      deriveProviderFromModel(extractPrimaryModel(createdAgent.model_settings) ?? input.model ?? null),
    has_credentials: false,
    is_resolved: true,
  };
}
