import {
  WorkspaceSettingsPatchSchema,
  WorkspaceSettingsResponseSchema,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from "../../../../contracts/workspace-settings";
import { apiFetch } from "./client";

export async function fetchWorkspaceSettings(
  workspaceId: string,
): Promise<WorkspaceSettings> {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/settings`, {
    method: "GET",
    auth: "supabase",
    schema: WorkspaceSettingsResponseSchema,
  });
  return response.settings;
}

export async function patchWorkspaceSettings(input: {
  workspaceId: string;
  patch: WorkspaceSettingsPatch;
}): Promise<WorkspaceSettings> {
  // Validate client-side too so a programmer-error patch surfaces
  // before the round-trip.
  WorkspaceSettingsPatchSchema.parse(input.patch);

  const response = await apiFetch(
    `/api/workspaces/${input.workspaceId}/settings`,
    {
      method: "PATCH",
      auth: "supabase",
      body: input.patch,
      schema: WorkspaceSettingsResponseSchema,
    },
  );
  return response.settings;
}
