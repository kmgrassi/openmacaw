import type { ModelCatalogEntry } from "../../../../contracts/model-catalog.js";
import type { ProviderAdapter, ProviderCatalogResult, ProviderCredential } from "./model-catalog-types.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type CacheEntry = {
  models: ModelCatalogEntry[];
  fetchedAt: number;
};

const providerCache = new Map<string, CacheEntry>();

function cacheKey(adapter: ProviderAdapter, credential: ProviderCredential) {
  return `${adapter.provider}:${credential.sourceKey}`;
}

export function dedupeAndSort(models: ModelCatalogEntry[]) {
  const deduped = new Map<string, ModelCatalogEntry>();
  for (const model of models) {
    if (!deduped.has(model.id)) {
      deduped.set(model.id, model);
    }
  }
  return [...deduped.values()].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    if (Boolean(a.recommended) !== Boolean(b.recommended)) return a.recommended ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function fetchProviderCatalog(input: {
  adapter: ProviderAdapter;
  credential: ProviderCredential;
  refresh: boolean;
}): Promise<ProviderCatalogResult> {
  const key = cacheKey(input.adapter, input.credential);
  const cached = providerCache.get(key);
  const now = Date.now();
  if (!input.refresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      models: cached.models.map((model) => ({ ...model, source: "cache" })),
      errors: [],
    };
  }

  try {
    const models = await input.adapter.fetchModels(input.credential);
    providerCache.set(key, { models, fetchedAt: now });
    return { models, errors: [] };
  } catch (error) {
    if (cached) {
      return {
        models: cached.models.map((model) => ({ ...model, source: "cache" })),
        errors: [
          {
            provider: input.adapter.provider,
            code: "provider_unavailable",
            message: String(error),
          },
        ],
      };
    }
    return {
      models: [],
      errors: [
        {
          provider: input.adapter.provider,
          code: "provider_unavailable",
          message: String(error),
        },
      ],
    };
  }
}

export function clearProviderCacheForTests() {
  providerCache.clear();
}
