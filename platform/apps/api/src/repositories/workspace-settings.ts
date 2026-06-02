import { z } from "zod";

import { parseNullableSupabaseRow, parseSupabaseRow } from "../lib/supabase-row-parsers.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { withRepositoryLogging } from "./logging.js";

const WorkspaceSettingsRowSchema = z.object({
  workspace_id: z.string(),
  learning_enabled: z.boolean(),
  tracker_kind: z.string().nullable().default(null),
  tracker_credential_id: z.string().nullable().default(null),
  updated_at: z.string().nullable(),
  updated_by_user_id: z.string().nullable(),
});

export type WorkspaceSettingsRow = z.infer<typeof WorkspaceSettingsRowSchema>;

const WORKSPACE_SETTINGS_SELECT =
  "workspace_id,learning_enabled,tracker_kind,tracker_credential_id,updated_at,updated_by_user_id" as const;

/**
 * Read the `workspace_settings` row for a workspace. Returns `null`
 * when no row exists — the service layer treats that as "use column
 * defaults," which is the common case for workspaces that have never
 * had their settings written.
 */
export async function getWorkspaceSettingsRow(workspaceId: string): Promise<WorkspaceSettingsRow | null> {
  return withRepositoryLogging(
    {
      repository: "workspace_settings",
      method: "getWorkspaceSettingsRow",
      table: "workspace_settings",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("workspace_settings")
        .select(WORKSPACE_SETTINGS_SELECT)
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("workspace_settings query", error);
      return parseNullableSupabaseRow("workspace_settings query", WorkspaceSettingsRowSchema, data);
    },
  );
}

/**
 * Upsert the `workspace_settings` row. Used for both first-write
 * (insert) and subsequent updates (update by PK conflict).
 *
 * Caller passes the *full* desired row — the service layer is
 * responsible for merging a partial patch over current values before
 * calling here. Storing the merged shape rather than the patch keeps
 * the row self-describing for any future direct SQL consumer.
 */
export async function upsertWorkspaceSettingsRow(input: {
  workspaceId: string;
  learningEnabled: boolean;
  trackerKind: string;
  trackerCredentialId: string | null;
  updatedByUserId?: string | null;
}): Promise<WorkspaceSettingsRow> {
  return withRepositoryLogging(
    {
      repository: "workspace_settings",
      method: "upsertWorkspaceSettingsRow",
      table: "workspace_settings",
      operation: "upsert",
      expectedCardinality: "exactly_one",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("workspace_settings")
        .upsert(
          {
            workspace_id: input.workspaceId,
            learning_enabled: input.learningEnabled,
            tracker_kind: input.trackerKind,
            tracker_credential_id: input.trackerCredentialId,
            updated_by_user_id: input.updatedByUserId ?? null,
          } as never,
          { onConflict: "workspace_id" },
        )
        .select(WORKSPACE_SETTINGS_SELECT)
        .single();

      if (error) throw normalizeSupabaseError("workspace_settings upsert", error);
      return parseSupabaseRow("workspace_settings upsert", WorkspaceSettingsRowSchema, data);
    },
  );
}
