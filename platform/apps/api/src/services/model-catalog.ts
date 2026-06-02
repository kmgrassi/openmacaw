import {
  MODEL_CATALOG_FALLBACK,
  type ModelCatalogResponse,
  type ModelProviderConnection,
  type ModelProviderListResponse,
  type ModelProvider,
} from "../../../../contracts/model-catalog.js";
import { findEnvCredential, loadAgentCredentials, loadWorkspaceCredentials } from "./model-catalog-credentials.js";
import { adapterByProvider, MODEL_PROVIDER_DEFINITIONS, modelProviderAdapters } from "./model-catalog-providers.js";
import { clearProviderCacheForTests, dedupeAndSort, fetchProviderCatalog } from "./model-catalog-runtime.js";

export { MODEL_PROVIDER_DEFINITIONS };

export function clearModelCatalogCacheForTests() {
  clearProviderCacheForTests();
}

export async function listModelCatalog(
  input: {
    agentId?: string | null;
    workspaceId?: string | null;
    userId?: string | null;
    refresh?: boolean;
  } = {},
): Promise<ModelCatalogResponse> {
  const workspaceCredentialLookup = await loadWorkspaceCredentials(input.workspaceId, input.userId);
  const agentCredentialLookup = await loadAgentCredentials(input.agentId, input.workspaceId);
  const providerResults = await Promise.all(
    modelProviderAdapters.map(async (adapter) => {
      const credential =
        agentCredentialLookup.credentials.get(adapter.provider) ??
        workspaceCredentialLookup.credentials.get(adapter.provider) ??
        (input.workspaceId ? null : findEnvCredential(adapter));
      if (!credential) return { models: [], errors: [] };
      return fetchProviderCatalog({ adapter, credential, refresh: Boolean(input.refresh) });
    }),
  );

  const liveModels = providerResults.flatMap((result) => result.models);
  const errors = [
    ...workspaceCredentialLookup.errors,
    ...agentCredentialLookup.errors,
    ...providerResults.flatMap((result) => result.errors),
  ];
  const models = dedupeAndSort(input.workspaceId ? liveModels : [...liveModels, ...MODEL_CATALOG_FALLBACK]);

  return {
    models,
    fetchedAt: new Date().toISOString(),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function validateModelProviderCredential(input: {
  provider: ModelProvider;
  apiKey: string;
  endpoint?: string | null;
  apiVersion?: string | null;
}) {
  const adapter = adapterByProvider.get(input.provider);
  if (!adapter) {
    throw new Error(`Unsupported provider ${input.provider}`);
  }

  const result = await fetchProviderCatalog({
    adapter,
    credential: {
      value: input.apiKey,
      sourceKey: `validation:${input.provider}:${Date.now()}`,
      endpoint: input.endpoint,
      apiVersion: input.apiVersion,
    },
    refresh: true,
  });
  const error = result.errors[0] ?? null;
  return {
    ok: result.models.length > 0 && !error,
    modelCount: result.models.length,
    checkedAt: new Date().toISOString(),
    error: error?.message ?? null,
  };
}

export async function listModelProviderConnections(input: {
  workspaceId: string;
  userId?: string | null;
  refresh?: boolean;
}): Promise<ModelProviderListResponse> {
  const credentials = await loadWorkspaceCredentials(input.workspaceId, input.userId);
  const providers = await Promise.all(
    modelProviderAdapters.map(async (adapter): Promise<ModelProviderConnection> => {
      const credential = credentials.credentials.get(adapter.provider) ?? null;
      if (!credential) {
        return {
          id: adapter.provider,
          name: adapter.providerName,
          description: adapter.description,
          authMode: adapter.authModes[0],
          credentialConfigured: false,
          valid: null,
          lastValidatedAt: null,
          lastError: null,
          requiresEndpoint: Boolean(adapter.requiresEndpoint),
        };
      }

      const result = await fetchProviderCatalog({
        adapter,
        credential,
        refresh: Boolean(input.refresh),
      });
      const error = result.errors[0] ?? null;
      return {
        id: adapter.provider,
        name: adapter.providerName,
        description: adapter.description,
        authMode: adapter.authModes[0],
        credentialConfigured: true,
        valid: !error && result.models.length > 0,
        modelCount: result.models.length,
        lastValidatedAt: new Date().toISOString(),
        lastError: error?.message ?? null,
        requiresEndpoint: Boolean(adapter.requiresEndpoint),
      };
    }),
  );

  return {
    providers,
    fetchedAt: new Date().toISOString(),
  };
}
