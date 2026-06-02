import crypto from "node:crypto";

import type { TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import type { getServiceRoleSupabase } from "../../supabase-client.js";

/** Generate a random local-runtime-helper token prefixed with lrh_. */
export function generateMachineToken(): string {
  return `lrh_${crypto.randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex digest of a plaintext token (stored in DB, never the plaintext). */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

type SupabaseClient = ReturnType<typeof getServiceRoleSupabase>;

export async function createMachineToken(input: { supabase: SupabaseClient; machineId: string; workspaceId: string }) {
  const plaintextToken = generateMachineToken();
  const { error } = await input.supabase.from("local_runtime_token").insert({
    machine_id: input.machineId,
    workspace_id: input.workspaceId,
    token_hash: hashToken(plaintextToken),
  } satisfies TablesInsert<"local_runtime_token">);

  return { plaintextToken, error };
}

export async function revokeActiveMachineTokens(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  machineIds: string[];
  revokedAt: string;
}) {
  const machineIds = Array.from(new Set(input.machineIds.filter((id) => id.trim().length > 0)));
  if (machineIds.length === 0) return;

  const { error } = await input.supabase
    .from("local_runtime_token")
    .update({ revoked_at: input.revokedAt } satisfies TablesUpdate<"local_runtime_token">)
    .eq("workspace_id", input.workspaceId)
    .in("machine_id", machineIds)
    .is("revoked_at", null);

  if (error) {
    assertSupabaseSuccess("revoke local runtime machine tokens", null, error);
  }
}

export async function rotateMachineToken(input: { supabase: SupabaseClient; workspaceId: string; machineId: string }) {
  await revokeActiveMachineTokens({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    machineIds: [input.machineId],
    revokedAt: new Date().toISOString(),
  });

  const { plaintextToken, error } = await createMachineToken(input);
  if (error) {
    assertSupabaseSuccess("rotate local runtime machine token", null, error);
  }

  return plaintextToken;
}
