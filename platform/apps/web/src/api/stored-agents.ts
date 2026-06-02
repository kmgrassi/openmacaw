import {
  AgentRuntimeProfileResponseSchema,
  StoredAgentListResponseSchema,
  type AgentType,
  type AgentRuntimeProfile,
  type AgentRuntimeProfileUpdateRequest,
  type PlanningDestination,
  type StoredAgent,
} from "../../../../contracts/agents";
import {
  StoredAgentMutationResponseSchema,
  type StoredAgentCreateRequest,
  type StoredAgentUpdateRequest,
} from "../../../../contracts/stored-agent-management";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export type AgentFormInput = StoredAgentCreateRequest;
export type AgentUpdateInput = StoredAgentUpdateRequest;

export type { AgentType, PlanningDestination, StoredAgent };

export async function listStoredAgents(): Promise<StoredAgent[]> {
  const response = await apiFetch(ROUTES.storedAgents, {
    schema: StoredAgentListResponseSchema,
    defaultErrorMessage: "Could not load stored agents",
  });
  return response.agents;
}

export async function createStoredAgent(
  input: AgentFormInput,
): Promise<StoredAgent> {
  const response = await apiFetch(ROUTES.storedAgents, {
    method: "POST",
    body: input,
    schema: StoredAgentMutationResponseSchema,
    defaultErrorMessage: "Could not create stored agent",
  });
  return response.agent;
}

export async function updateStoredAgent(
  agentId: string,
  input: AgentUpdateInput,
): Promise<void> {
  await apiFetch(ROUTES.storedAgent(agentId), {
    method: "PATCH",
    body: input,
    schema: StoredAgentMutationResponseSchema,
    defaultErrorMessage: "Could not update stored agent",
  });
}

export async function deleteStoredAgent(agentId: string): Promise<void> {
  await apiFetch(ROUTES.storedAgent(agentId), {
    method: "DELETE",
    defaultErrorMessage: "Could not delete stored agent",
  });
}

export async function ensureStoredAgentDefaultRouting(
  agentId: string,
): Promise<{ changed: boolean }> {
  return apiFetch<{ changed: boolean }>(
    ROUTES.storedAgentEnsureDefaultRouting(agentId),
    {
      method: "POST",
      defaultErrorMessage: "Could not ensure default agent routing",
    },
  );
}

export async function getAgentRuntimeProfile(
  agentId: string,
  workspaceId?: string | null,
): Promise<AgentRuntimeProfile> {
  const response = await apiFetch(
    ROUTES.agentRuntimeProfile(agentId, workspaceId),
    {
      schema: AgentRuntimeProfileResponseSchema,
      defaultErrorMessage: "Could not load agent runtime profile",
    },
  );
  return response.profile;
}

export async function updateAgentRuntimeProfile(
  agentId: string,
  input: AgentRuntimeProfileUpdateRequest,
): Promise<AgentRuntimeProfile> {
  const response = await apiFetch(ROUTES.agentRuntimeProfile(agentId), {
    method: "PUT",
    body: input,
    schema: AgentRuntimeProfileResponseSchema,
    defaultErrorMessage: "Could not save agent runtime profile",
  });
  return response.profile;
}
