import {
  ModelCatalogResponseSchema,
  ModelProviderListResponseSchema,
  ModelProviderSchema,
  SaveModelProviderCredentialResponseSchema,
  MODEL_CATALOG_FALLBACK,
} from "../../../../contracts/model-catalog";
import {
  CredentialProviderSchema,
  type CredentialProvider,
} from "../../../../contracts/credentials";
import type {
  ModelCatalogResponse,
  ModelProvider,
  ModelProviderListResponse,
  SaveModelProviderCredentialResponse,
} from "../../../../contracts/model-catalog";
import { brokerFetch } from "./broker-fetch";
import { saveStoredCredential } from "./credentials";

type ListModelCatalogInput = {
  agentId?: string | null;
  workspaceId?: string | null;
  refresh?: boolean;
};

type CredentialModelProvider = Extract<CredentialProvider, ModelProvider>;

function isCredentialModelProvider(
  provider: CredentialProvider,
): provider is CredentialModelProvider {
  return ModelProviderSchema.safeParse(provider).success;
}

export async function listModelCatalog(
  input: ListModelCatalogInput = {},
): Promise<ModelCatalogResponse> {
  const params = new URLSearchParams();
  if (input.agentId) params.set("agentId", input.agentId);
  if (input.workspaceId) params.set("workspaceId", input.workspaceId);
  if (input.refresh) params.set("refresh", "true");

  const response = await brokerFetch(
    `/api/models${params.size ? `?${params.toString()}` : ""}`,
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `/api/models failed (${response.status})${body ? `: ${body}` : ""}`,
    );
  }

  return ModelCatalogResponseSchema.parse(await response.json());
}

export async function listModelProviders(input: {
  workspaceId: string;
  refresh?: boolean;
}): Promise<ModelProviderListResponse> {
  const params = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.refresh) params.set("refresh", "true");

  const response = await brokerFetch(
    `/api/model-providers?${params.toString()}`,
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `/api/model-providers failed (${response.status})${body ? `: ${body}` : ""}`,
    );
  }

  return ModelProviderListResponseSchema.parse(await response.json());
}

export async function saveModelProviderCredential(
  provider: ModelProvider,
  input: {
    workspaceId: string;
    apiKey: string;
    endpoint?: string;
    apiVersion?: string;
  },
): Promise<SaveModelProviderCredentialResponse> {
  const parsedProvider = CredentialProviderSchema.safeParse(provider);
  if (
    !parsedProvider.success ||
    !isCredentialModelProvider(parsedProvider.data)
  ) {
    throw new Error(`${provider} does not support stored API key credentials`);
  }

  await saveStoredCredential({
    scope: { kind: "workspace", workspaceId: input.workspaceId },
    provider: parsedProvider.data,
    apiKey: input.apiKey,
    endpoint: input.endpoint,
    apiVersion: input.apiVersion,
  });

  const params = new URLSearchParams({ workspaceId: input.workspaceId });
  const response = await brokerFetch(
    `/api/model-providers?${params.toString()}`,
    {
      method: "GET",
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
    const parsed = body as { error?: { message?: string } };
    throw new Error(
      parsed.error?.message ||
        `Failed to refresh provider state (${response.status})`,
    );
  }

  const providers = ModelProviderListResponseSchema.parse(body);
  const savedProvider = providers.providers.find(
    (candidate) => candidate.id === provider,
  );
  if (!savedProvider) {
    throw new Error(
      "Provider credential was saved but state could not be read",
    );
  }

  return SaveModelProviderCredentialResponseSchema.parse({
    provider: savedProvider,
  });
}

export function fallbackModelCatalog(): ModelCatalogResponse {
  return {
    models: MODEL_CATALOG_FALLBACK,
    fetchedAt: new Date().toISOString(),
  };
}
