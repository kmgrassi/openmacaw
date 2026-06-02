import {
  arrayFromPayload,
  extractContextWindow,
  extractDisplayName,
  extractModelOrId,
  makeModelEntry,
  normalizePayloadModels,
} from "./model-catalog-normalization.js";
import type { ProviderAdapter, ProviderCredential } from "./model-catalog-types.js";
import type { ModelProvider } from "../../../../contracts/model-catalog.js";

const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

async function fetchJson(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Provider catalog request timed out after ${PROVIDER_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function openAiCompatibleAdapter(input: {
  provider: ModelProvider;
  providerName: string;
  description: string;
  envVars: string[];
  url: string;
  include?: (id: string) => boolean;
}): ProviderAdapter {
  return {
    provider: input.provider,
    providerName: input.providerName,
    description: input.description,
    envVars: input.envVars,
    authModes: ["api_key"],
    fetchModels: async (credential) => {
      const fetchedAt = new Date().toISOString();
      const payload = await fetchJson(input.url, {
        headers: {
          authorization: `Bearer ${credential.value}`,
        },
      });
      return normalizePayloadModels({
        payload,
        provider: input.provider,
        providerName: input.providerName,
        authModes: ["api_key"],
        source: "provider",
        lastFetchedAt: fetchedAt,
        include: input.include,
      });
    },
  };
}

function includeOpenAiLanguageModel(id: string) {
  const lower = id.toLowerCase();
  if (/(audio|dall-e|embedding|image|moderation|realtime|speech|transcribe|tts|whisper)/.test(lower)) {
    return false;
  }
  return /^(gpt-|o\d|chatgpt-|codex)/i.test(id);
}

export const modelProviderAdapters: ProviderAdapter[] = [
  openAiCompatibleAdapter({
    provider: "openai",
    providerName: "OpenAI",
    description: "GPT and reasoning models available through the OpenAI API.",
    envVars: ["OPENAI_API_KEY"],
    url: "https://api.openai.com/v1/models",
    include: includeOpenAiLanguageModel,
  }),
  {
    provider: "anthropic",
    providerName: "Anthropic",
    description: "Claude models available through the Anthropic API.",
    envVars: ["ANTHROPIC_API_KEY"],
    authModes: ["api_key"],
    fetchModels: async (credential) => {
      const fetchedAt = new Date().toISOString();
      const payload = await fetchJson("https://api.anthropic.com/v1/models", {
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": credential.value,
        },
      });
      return normalizePayloadModels({
        payload,
        provider: "anthropic",
        providerName: "Anthropic",
        authModes: ["api_key"],
        source: "provider",
        lastFetchedAt: fetchedAt,
      });
    },
  },
  openAiCompatibleAdapter({
    provider: "xai",
    providerName: "xAI",
    description: "Grok models available through xAI.",
    envVars: ["XAI_API_KEY"],
    url: "https://api.x.ai/v1/models",
  }),
  {
    provider: "google",
    providerName: "Google Gemini",
    description: "Gemini models available through the Google Generative Language API.",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    authModes: ["api_key"],
    fetchModels: async (credential) => {
      const fetchedAt = new Date().toISOString();
      const payload = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(credential.value)}`,
        {},
      );
      return normalizePayloadModels({
        payload,
        provider: "google",
        providerName: "Google Gemini",
        authModes: ["api_key"],
        source: "provider",
        lastFetchedAt: fetchedAt,
      });
    },
  },
  openAiCompatibleAdapter({
    provider: "mistral",
    providerName: "Mistral",
    description: "Mistral hosted models available through the Mistral API.",
    envVars: ["MISTRAL_API_KEY"],
    url: "https://api.mistral.ai/v1/models",
  }),
  openAiCompatibleAdapter({
    provider: "groq",
    providerName: "Groq",
    description: "Fast hosted open models available through Groq.",
    envVars: ["GROQ_API_KEY"],
    url: "https://api.groq.com/openai/v1/models",
  }),
  openAiCompatibleAdapter({
    provider: "openrouter",
    providerName: "OpenRouter",
    description: "OpenRouter model marketplace catalog.",
    envVars: ["OPENROUTER_API_KEY"],
    url: "https://openrouter.ai/api/v1/models",
  }),
  openAiCompatibleAdapter({
    provider: "together",
    providerName: "Together AI",
    description: "Open and proprietary hosted models available through Together AI.",
    envVars: ["TOGETHER_API_KEY"],
    url: "https://api.together.xyz/v1/models",
  }),
  openAiCompatibleAdapter({
    provider: "perplexity",
    providerName: "Perplexity",
    description: "Sonar models available through the Perplexity API.",
    envVars: ["PERPLEXITY_API_KEY"],
    url: "https://api.perplexity.ai/v1/models",
  }),
  {
    provider: "azure",
    providerName: "Azure OpenAI",
    description: "Azure OpenAI deployments configured on your Azure resource.",
    envVars: ["AZURE_OPENAI_API_KEY"],
    authModes: ["api_key"],
    requiresEndpoint: true,
    fetchModels: async (credential: ProviderCredential) => {
      const endpoint = (credential.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT)?.trim().replace(/\/+$/, "");
      if (!endpoint) {
        throw new Error("Azure OpenAI endpoint is required");
      }

      const fetchedAt = new Date().toISOString();
      const apiVersion = credential.apiVersion?.trim() || process.env.AZURE_OPENAI_API_VERSION?.trim() || "2024-02-01";
      const payload = await fetchJson(`${endpoint}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`, {
        headers: {
          "api-key": credential.value,
        },
      });
      return (arrayFromPayload(payload) ?? [])
        .map((item) => {
          const rawId = extractModelOrId(item);
          if (!rawId) return null;
          return makeModelEntry({
            provider: "azure",
            providerName: "Azure OpenAI",
            rawId,
            name: extractDisplayName(item),
            authModes: ["api_key"],
            source: "provider",
            lastFetchedAt: fetchedAt,
            contextWindow: extractContextWindow(item),
          });
        })
        .filter((model): model is NonNullable<typeof model> => Boolean(model));
    },
  },
];

export const adapterByProvider = new Map(modelProviderAdapters.map((adapter) => [adapter.provider, adapter]));

export const MODEL_PROVIDER_DEFINITIONS = modelProviderAdapters.map((adapter) => ({
  id: adapter.provider,
  name: adapter.providerName,
  description: adapter.description,
  authMode: adapter.authModes[0],
  requiresEndpoint: Boolean(adapter.requiresEndpoint),
}));
