import type { TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";
import { executeSupabaseRows, getServiceRoleSupabase } from "../../supabase-client.js";
import type { NormalizedWorkItemInput, PersistedWorkItem, WorkItemRow } from "./types.js";
import { asString } from "./validation.js";

export async function assertWorkspaceMembership(userId: string, workspaceId: string) {
  userId = asString(userId) ?? "";
  if (!userId) {
    throw new Error("Authenticated user context is required");
  }

  const rows = await executeSupabaseRows<{ workspace_id: string }>(
    "workspace_members query",
    getServiceRoleSupabase()
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .limit(1),
  );

  if (rows.length > 0) return;

  const owned = await executeSupabaseRows<{ id: string }>(
    "workspaces query",
    getServiceRoleSupabase().from("workspaces").select("id").eq("id", workspaceId).eq("owner_user_id", userId).limit(1),
  );

  if (owned.length === 0) {
    throw new Error("Authenticated user is not authorized for the requested workspace");
  }
}

export async function upsertWorkItemFromNormalizedInput(input: NormalizedWorkItemInput): Promise<PersistedWorkItem> {
  const now = new Date().toISOString();
  const existingRows = await executeSupabaseRows<WorkItemRow>(
    "work_items query",
    getServiceRoleSupabase()
      .from("work_items")
      .select("*")
      .eq("workspace_id", input.workspaceId)
      .eq("source", input.source)
      .eq("metadata->>external_id", input.externalId)
      .limit(1),
  );

  const workItemBody = {
    workspace_id: input.workspaceId,
    plan_id: input.planId ?? null,
    title: input.title,
    description: input.description,
    instructions: input.description,
    state: input.state,
    priority: input.priority,
    source: input.source,
    labels: input.labels,
    metadata: {
      ...input.metadata,
      external_id: input.externalId,
    },
    updated_at: now,
  } satisfies TablesInsert<"work_items"> & TablesUpdate<"work_items">;

  const existing = existingRows[0];
  const workItems = await executeSupabaseRows<WorkItemRow>(
    existing?.id ? "work_items update" : "work_items insert",
    existing?.id
      ? getServiceRoleSupabase().from("work_items").update(workItemBody).eq("id", existing.id).select("*")
      : getServiceRoleSupabase().from("work_items").insert(workItemBody).select("*"),
  );

  const workItem = workItems[0] ?? null;
  if (!workItem?.id) {
    throw new Error("Work item write returned no row");
  }

  return {
    workItem,
  };
}
