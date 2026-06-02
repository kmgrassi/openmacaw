import {
  AgentHealthResponseSchema,
  type AgentHealthResponse,
} from "../../../../contracts/agent-health";
import {
  AgentCredentialConfigurationRequestSchema,
  AgentCredentialConfigurationResponseSchema,
  DefaultAgentAssignmentUpdateRequestSchema,
  DefaultAgentCredentialApplicationRequestSchema,
  DefaultAgentCredentialApplicationResponseSchema,
  ManagerCredentialActivationRequestSchema,
  ManagerCredentialActivationResponseSchema,
  SetupAuthStateSchema,
  SetupRequestSchema,
  SetupResponseSchema,
  SetupUpdateRequestSchema,
  type AgentCredentialConfigurationRequest,
  type DefaultAgentAssignmentUpdateRequest,
  type DefaultAgentCredentialApplicationRequest,
  type ManagerCredentialActivationRequest,
  type SetupAuthState,
  type SetupRequest,
  type SetupResponse,
  type SetupUpdateRequest,
} from "../../../../contracts/setup";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export async function fetchSetupAuthState(): Promise<SetupAuthState> {
  return apiFetch(ROUTES.authState, {
    method: "GET",
    auth: "supabase",
    schema: SetupAuthStateSchema,
  });
}

export async function updateDefaultAgentAssignment(
  input: DefaultAgentAssignmentUpdateRequest,
): Promise<SetupAuthState> {
  const payload = DefaultAgentAssignmentUpdateRequestSchema.parse(input);
  return apiFetch(ROUTES.defaultAgentAssignment, {
    method: "PUT",
    auth: "supabase",
    body: payload,
    schema: SetupAuthStateSchema,
  });
}

export async function applyDefaultAgentCredentials(
  input: DefaultAgentCredentialApplicationRequest,
): Promise<SetupAuthState> {
  const payload = DefaultAgentCredentialApplicationRequestSchema.parse(input);
  const response = await apiFetch(ROUTES.defaultAgentCredentials, {
    method: "POST",
    auth: "supabase",
    body: payload,
    schema: DefaultAgentCredentialApplicationResponseSchema,
  });
  return response.authState;
}

export async function createSetup(input: SetupRequest): Promise<SetupResponse> {
  const payload = SetupRequestSchema.parse(input);
  return apiFetch(ROUTES.setup, {
    method: "POST",
    auth: "supabase",
    body: payload,
    schema: SetupResponseSchema,
  });
}

export async function updateSetup(
  input: SetupUpdateRequest,
): Promise<SetupResponse> {
  const payload = SetupUpdateRequestSchema.parse(input);
  return apiFetch(ROUTES.setup, {
    method: "PUT",
    auth: "supabase",
    body: payload,
    schema: SetupResponseSchema,
  });
}

export async function configureAgentCredentials(
  input: AgentCredentialConfigurationRequest,
): Promise<SetupResponse> {
  const payload = AgentCredentialConfigurationRequestSchema.parse(input);
  const response = await apiFetch(ROUTES.setupAgentCredentials, {
    method: "POST",
    auth: "supabase",
    body: payload,
    schema: AgentCredentialConfigurationResponseSchema,
  });
  return response.setup;
}

export async function activateManagerAgentCredentials(
  input: ManagerCredentialActivationRequest,
): Promise<SetupAuthState> {
  const payload = ManagerCredentialActivationRequestSchema.parse(input);
  const response = await apiFetch(ROUTES.managerAgentActivation, {
    method: "POST",
    auth: "supabase",
    body: payload,
    schema: ManagerCredentialActivationResponseSchema,
  });
  return response.authState;
}

export async function fetchSetup(agentId: string): Promise<SetupResponse> {
  return apiFetch(ROUTES.setupByAgent(agentId), {
    method: "GET",
    auth: "supabase",
    schema: SetupResponseSchema,
  });
}

export async function fetchAgentHealth(
  agentId: string,
): Promise<AgentHealthResponse> {
  return apiFetch(ROUTES.agentHealth(agentId), {
    method: "GET",
    auth: "supabase",
    schema: AgentHealthResponseSchema,
  });
}
