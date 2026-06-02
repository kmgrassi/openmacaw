import {
  AgentCredentialReferenceResponseSchema,
  CreateCredentialResponseSchema,
  CredentialAliasListResponseSchema,
  StoredCredentialActivationResponseSchema,
  SavedCredentialListResponseSchema,
  UpsertCredentialAliasResponseSchema,
  type CodingHandoffRequest,
  type AgentCredentialReferenceResponse,
  type CredentialAlias,
  type CredentialScope,
  type CredentialReference,
  type CredentialProvider,
  type CreateCredentialResponse,
  type SavedCredential,
  type StoredCredentialActivationResponse,
} from "../../../../contracts/credentials";
import { resolveBrokerBase } from "./broker";
import { brokerFetch } from "./broker-fetch";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";
export type {
  CredentialProvider,
  CredentialScope,
  SavedCredential,
  CreateCredentialResponse,
  StoredCredentialActivationResponse,
  CredentialAlias,
  CredentialReference,
  AgentCredentialReferenceResponse,
} from "../../../../contracts/credentials";

type ErrorResponse = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export async function listSavedCredentialsForAgent(
  agentId: string,
  workspaceId: string,
): Promise<SavedCredential[]> {
  const path = `${resolveBrokerBase()}${ROUTES.storedAgentCredentials(agentId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
  const response = await brokerFetch(path, {
    method: "GET",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to load stored credentials (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  const body = SavedCredentialListResponseSchema.parse(await response.json());
  return body.credentials;
}

export async function listSavedCredentialsForWorkspace(
  workspaceId: string,
): Promise<SavedCredential[]> {
  const body = await apiFetch(
    `${ROUTES.credentials}?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "GET",
      schema: SavedCredentialListResponseSchema,
      defaultErrorMessage: (status) =>
        `Failed to load workspace credentials (${status})`,
    },
  );
  return body.credentials;
}

export async function listCredentialAliases(
  workspaceId: string,
): Promise<CredentialAlias[]> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.credentialAliases}?workspaceId=${encodeURIComponent(workspaceId)}`,
    { method: "GET" },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to load credential aliases (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  const body = CredentialAliasListResponseSchema.parse(await response.json());
  return body.aliases;
}

export async function saveCredentialAlias(input: {
  workspaceId: string;
  alias: string;
  credentialId: string;
}): Promise<CredentialAlias> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.credentialAlias(input.alias)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const parsed = body as ErrorResponse;
    throw new Error(
      parsed.error?.message ||
        `Failed to save credential alias (${response.status})`,
    );
  }

  return UpsertCredentialAliasResponseSchema.parse(body).alias;
}

export async function getAgentCredentialReference(
  agentId: string,
  workspaceId: string,
): Promise<AgentCredentialReferenceResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.storedAgentCredentialReference(agentId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    { method: "GET" },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to load credential reference (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  return AgentCredentialReferenceResponseSchema.parse(await response.json());
}

export async function saveAgentCredentialReference(input: {
  agentId: string;
  workspaceId: string;
  runnerKind?: string;
  provider?: string | null;
  model?: string | null;
  localModelId?: string | null;
  localEndpointUrl?: string | null;
  credentialRef: CredentialReference | null;
}): Promise<AgentCredentialReferenceResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.storedAgentCredentialReference(input.agentId)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        runnerKind: input.runnerKind,
        provider: input.provider,
        model: input.model,
        localModelId: input.localModelId,
        localEndpointUrl: input.localEndpointUrl,
        credentialRef: input.credentialRef,
      }),
    },
  );

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const parsed = body as ErrorResponse;
    throw new Error(
      parsed.error?.message ||
        `Failed to save credential reference (${response.status})`,
    );
  }

  return AgentCredentialReferenceResponseSchema.parse(body);
}

export async function launchSavedCredential(
  agentId: string,
  credentialId: string,
  cwd: string,
  workspaceId: string,
  handoff?: CodingHandoffRequest | null,
): Promise<StoredCredentialActivationResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.storedAgentCredentialLaunch(agentId, credentialId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ cwd, workspaceId, handoff: handoff ?? null }),
    },
  );

  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text || {};
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error?: unknown }).error ?? "")
        : "";
    throw new Error(
      message || `Failed to launch stored credential (${response.status})`,
    );
  }

  return StoredCredentialActivationResponseSchema.parse(body);
}

export async function activateStoredAgent(
  agentId: string,
  workspaceId: string,
  cwd: string,
) {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.storedAgentActivate(agentId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId, cwd }),
    },
  );

  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text || {};
  }

  if (!response.ok) {
    const parsed = body as ErrorResponse;
    const error = new Error(
      parsed.error?.message ||
        `Failed to activate stored agent (${response.status})`,
    ) as Error & { code?: string; details?: unknown };
    error.code = parsed.error?.code;
    error.details = parsed.error?.details;
    throw error;
  }

  return StoredCredentialActivationResponseSchema.parse(body);
}

export async function saveStoredCredential(input: {
  scope: CredentialScope;
  provider: CredentialProvider;
  apiKey: string;
  endpoint?: string;
  apiVersion?: string;
  alias?: string;
}): Promise<CreateCredentialResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.credentials}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: input.scope,
        key: {
          format: "api_key",
          provider: input.provider,
          secret: input.apiKey,
          endpoint: input.endpoint,
          apiVersion: input.apiVersion,
        },
        alias: input.alias,
      }),
    },
  );

  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text || {};
  }

  if (!response.ok) {
    const parsed = body as ErrorResponse;
    throw new Error(
      parsed.error?.message ||
        `Failed to save stored credential (${response.status})`,
    );
  }

  return CreateCredentialResponseSchema.parse(body);
}
