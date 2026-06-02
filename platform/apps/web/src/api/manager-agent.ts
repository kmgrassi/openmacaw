import {
  ManagerAgentConfigRequestSchema,
  ManagerAgentConfigResponseSchema,
  ManagerRuntimeStatusResponseSchema,
  type ManagerAgentConfigRequest,
  type ManagerAgentConfigResponse,
  type ManagerRuntimeStatus,
} from "../../../../contracts/manager-agent";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export async function fetchManagerRuntimeStatus(
  workspaceId: string,
): Promise<ManagerRuntimeStatus> {
  const response = await apiFetch(ROUTES.managerAgentStatus(workspaceId), {
    schema: ManagerRuntimeStatusResponseSchema,
    defaultErrorMessage: "Could not load manager status",
  });
  return response.manager;
}

export async function fetchManagerAgentConfig(
  workspaceId: string,
  agentId: string,
): Promise<ManagerAgentConfigResponse> {
  return apiFetch(ROUTES.managerAgentConfig(agentId, workspaceId), {
    schema: ManagerAgentConfigResponseSchema,
    defaultErrorMessage: "Could not load manager agent settings",
  });
}

export async function updateManagerAgentConfig(
  workspaceId: string,
  agentId: string,
  input: ManagerAgentConfigRequest,
): Promise<ManagerAgentConfigResponse> {
  const payload = ManagerAgentConfigRequestSchema.parse(input);
  return apiFetch(ROUTES.managerAgentConfig(agentId, workspaceId), {
    method: "PUT",
    body: payload,
    schema: ManagerAgentConfigResponseSchema,
    defaultErrorMessage: "Could not save manager agent settings",
  });
}
