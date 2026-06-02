// Generated from contracts/platform-api-contracts.ts. Do not edit by hand.

import type {
  AgentToolSettingsResponse,
  AppendToolExamplesRequest,
  ApplyToolPolicyTemplateRequest,
  CreateToolDefinitionRequest,
  ReorderAgentToolsRequest,
  ToolDefinitionListResponse,
  ToolDefinitionResponse,
  UpdateToolDefinitionRequest,
  UpsertAgentToolGrantRequest,
} from "../../../../../contracts/tool-definition";
import { PlatformApiContracts } from "../../../../../contracts/platform-api-contracts";
import { apiFetch } from "../client";

type WorkspaceQuery = {
  workspaceId: string;
};

function buildQuery(query: Record<string, string>): string {
  const params = new URLSearchParams(query);
  return params.toString();
}

function withQuery(path: string, query: Record<string, string>): string {
  const encoded = buildQuery(query);
  return encoded ? `${path}?${encoded}` : path;
}

function routePath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) =>
    encodeURIComponent(params[key] ?? ""),
  );
}

export async function listAgentTools(
  input: { agentId: string } & WorkspaceQuery,
): Promise<AgentToolSettingsResponse> {
  return apiFetch(
    withQuery(
      routePath(PlatformApiContracts.listAgentTools.path, {
        agentId: input.agentId,
      }),
      {
        workspaceId: input.workspaceId,
      },
    ),
    {
      schema: PlatformApiContracts.listAgentTools.response,
      defaultErrorMessage: "Could not load assigned tools",
    },
  );
}

export async function applyAgentToolTemplate(
  agentId: string,
  templateId: string,
  body: ApplyToolPolicyTemplateRequest,
): Promise<AgentToolSettingsResponse> {
  return apiFetch(
    routePath(PlatformApiContracts.applyAgentToolTemplate.path, {
      agentId,
      templateId,
    }),
    {
      method: PlatformApiContracts.applyAgentToolTemplate.method,
      body,
      schema: PlatformApiContracts.applyAgentToolTemplate.response,
      defaultErrorMessage: "Could not apply tool template",
    },
  );
}

export async function upsertAgentToolGrant(
  agentId: string,
  toolId: string,
  body: UpsertAgentToolGrantRequest,
): Promise<AgentToolSettingsResponse> {
  return apiFetch(
    routePath(PlatformApiContracts.upsertAgentToolGrant.path, {
      agentId,
      toolId,
    }),
    {
      method: PlatformApiContracts.upsertAgentToolGrant.method,
      body,
      schema: PlatformApiContracts.upsertAgentToolGrant.response,
      defaultErrorMessage: "Could not save tool grant",
    },
  );
}

export async function deleteAgentToolGrant(
  input: { agentId: string; toolId: string } & WorkspaceQuery,
): Promise<AgentToolSettingsResponse> {
  return apiFetch(
    withQuery(
      routePath(PlatformApiContracts.deleteAgentToolGrant.path, {
        agentId: input.agentId,
        toolId: input.toolId,
      }),
      { workspaceId: input.workspaceId },
    ),
    {
      method: PlatformApiContracts.deleteAgentToolGrant.method,
      schema: PlatformApiContracts.deleteAgentToolGrant.response,
      defaultErrorMessage: "Could not delete tool grant",
    },
  );
}

export async function reorderAgentTools(
  agentId: string,
  body: ReorderAgentToolsRequest,
): Promise<{ toolIds: string[] }> {
  return apiFetch(
    routePath(PlatformApiContracts.reorderAgentTools.path, { agentId }),
    {
      method: PlatformApiContracts.reorderAgentTools.method,
      body,
      schema: PlatformApiContracts.reorderAgentTools.response,
      defaultErrorMessage: "Could not save tool order",
    },
  );
}

export async function listTools(
  input: WorkspaceQuery,
): Promise<ToolDefinitionListResponse> {
  return apiFetch(
    withQuery(PlatformApiContracts.listTools.path, {
      workspaceId: input.workspaceId,
    }),
    {
      schema: PlatformApiContracts.listTools.response,
      defaultErrorMessage: "Could not load tools",
    },
  );
}

export async function createToolDefinition(
  body: CreateToolDefinitionRequest,
): Promise<ToolDefinitionResponse> {
  return apiFetch(PlatformApiContracts.createToolDefinition.path, {
    method: PlatformApiContracts.createToolDefinition.method,
    body,
    schema: PlatformApiContracts.createToolDefinition.response,
    defaultErrorMessage: "Could not create tool",
  });
}

export async function updateToolDefinition(
  toolId: string,
  body: UpdateToolDefinitionRequest,
): Promise<ToolDefinitionResponse> {
  return apiFetch(
    routePath(PlatformApiContracts.updateToolDefinition.path, { toolId }),
    {
      method: PlatformApiContracts.updateToolDefinition.method,
      body,
      schema: PlatformApiContracts.updateToolDefinition.response,
      defaultErrorMessage: "Could not update tool",
    },
  );
}

export async function appendToolExamples(
  toolId: string,
  body: AppendToolExamplesRequest,
): Promise<ToolDefinitionResponse> {
  return apiFetch(
    routePath(PlatformApiContracts.appendToolExamples.path, { toolId }),
    {
      method: PlatformApiContracts.appendToolExamples.method,
      body,
      schema: PlatformApiContracts.appendToolExamples.response,
      defaultErrorMessage: "Could not append tool examples",
    },
  );
}

export async function appendToolExamplesBySlug(
  slug: string,
  body: AppendToolExamplesRequest,
): Promise<ToolDefinitionResponse> {
  return apiFetch(
    routePath(PlatformApiContracts.appendToolExamplesBySlug.path, { slug }),
    {
      method: PlatformApiContracts.appendToolExamplesBySlug.method,
      body,
      schema: PlatformApiContracts.appendToolExamplesBySlug.response,
      defaultErrorMessage: "Could not append tool examples",
    },
  );
}

export async function deleteToolDefinition(
  input: { toolId: string } & WorkspaceQuery,
): Promise<void> {
  await apiFetch(
    withQuery(
      routePath(PlatformApiContracts.deleteToolDefinition.path, {
        toolId: input.toolId,
      }),
      { workspaceId: input.workspaceId },
    ),
    {
      method: PlatformApiContracts.deleteToolDefinition.method,
      defaultErrorMessage: "Could not delete tool",
    },
  );
}
