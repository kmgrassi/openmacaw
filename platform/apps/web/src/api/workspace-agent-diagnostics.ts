import {
  WorkspaceAgentDiagnosticResponseSchema,
  type WorkspaceAgentDiagnosticResponse,
} from "../../../../contracts/agent-health";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export function getWorkspaceAgentDiagnostics(
  workspaceId: string,
): Promise<WorkspaceAgentDiagnosticResponse> {
  return apiFetch(ROUTES.workspaceAgentDiagnostics(workspaceId), {
    method: "GET",
    auth: "supabase",
    schema: WorkspaceAgentDiagnosticResponseSchema,
    defaultErrorMessage: (status) =>
      `workspace agent diagnostic request failed (${status})`,
  });
}
