import { assertSupabaseSuccess } from "../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../supabase-client.js";

export async function workspaceHasEmbeddedMemories(workspaceId: string) {
  const { data, error } = await getServiceRoleSupabase()
    .from("memory_items")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_deleted", false)
    .not("embedding", "is", null)
    .limit(1);

  assertSupabaseSuccess("memory_items embedded-memory lookup", data, error);
  return data.length > 0;
}
