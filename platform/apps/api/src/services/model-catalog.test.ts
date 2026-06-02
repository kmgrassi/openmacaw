import { afterEach, describe, expect, it, vi } from "vitest";

import { clearModelCatalogCacheForTests, listModelCatalog } from "./model-catalog.js";

const PROVIDER_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
] as const;

describe("model catalog service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearModelCatalogCacheForTests();
    for (const key of PROVIDER_ENV) {
      delete process.env[key];
    }
  });

  it("pulls and normalizes models from configured provider catalog endpoints", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    process.env.XAI_API_KEY = "xai-key";
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.MISTRAL_API_KEY = "mistral-key";
    process.env.GROQ_API_KEY = "groq-key";
    process.env.OPENROUTER_API_KEY = "openrouter-key";
    process.env.TOGETHER_API_KEY = "together-key";
    process.env.PERPLEXITY_API_KEY = "perplexity-key";
    process.env.AZURE_OPENAI_API_KEY = "azure-key";
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com/";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://api.openai.com/v1/models") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openai-key");
        return Response.json({
          data: [{ id: "gpt-live-openai" }, { id: "text-embedding-3-large" }, { id: "chatgpt-image-latest" }],
        });
      }
      if (url === "https://api.anthropic.com/v1/models") {
        expect(new Headers(init?.headers).get("x-api-key")).toBe("anthropic-key");
        expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
        return Response.json({ data: [{ id: "claude-live-anthropic" }] });
      }
      if (url === "https://api.x.ai/v1/models") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-key");
        return Response.json({ data: [{ id: "grok-live-xai" }] });
      }
      if (url === "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key") {
        return Response.json({ models: [{ name: "models/gemini-live-google" }] });
      }
      if (url === "https://api.mistral.ai/v1/models") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mistral-key");
        return Response.json({ data: [{ id: "mistral-live-model" }] });
      }
      if (url === "https://api.groq.com/openai/v1/models") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer groq-key");
        return Response.json({ data: [{ id: "llama-live-groq" }] });
      }
      if (url === "https://openrouter.ai/api/v1/models") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openrouter-key");
        return Response.json({ data: [{ id: "openrouter/live-model", name: "OpenRouter Live Model" }] });
      }
      if (url === "https://api.together.xyz/v1/models") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer together-key");
        return Response.json([{ id: "meta-llama/together-live-model" }]);
      }
      if (url === "https://api.perplexity.ai/v1/models") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer perplexity-key");
        return Response.json({ data: [{ id: "sonar-live-model" }] });
      }
      if (url === "https://example.openai.azure.com/openai/deployments?api-version=2024-02-01") {
        expect(new Headers(init?.headers).get("api-key")).toBe("azure-key");
        return Response.json({ data: [{ id: "deployment-1", model: "gpt-4o-azure-live" }] });
      }
      throw new Error(`Unexpected provider URL ${url}`);
    });

    const catalog = await listModelCatalog({ refresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(catalog.errors).toBeUndefined();
    expect(catalog.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openai/gpt-live-openai", provider: "openai", source: "provider" }),
        expect.objectContaining({ id: "anthropic/claude-live-anthropic", provider: "anthropic", source: "provider" }),
        expect.objectContaining({ id: "xai/grok-live-xai", provider: "xai", source: "provider" }),
        expect.objectContaining({ id: "google/gemini-live-google", provider: "google", source: "provider" }),
        expect.objectContaining({ id: "mistral/mistral-live-model", provider: "mistral", source: "provider" }),
        expect.objectContaining({ id: "groq/llama-live-groq", provider: "groq", source: "provider" }),
        expect.objectContaining({ id: "openrouter/live-model", provider: "openrouter", source: "provider" }),
        expect.objectContaining({
          id: "together/meta-llama/together-live-model",
          provider: "together",
          source: "provider",
        }),
        expect.objectContaining({ id: "perplexity/sonar-live-model", provider: "perplexity", source: "provider" }),
        expect.objectContaining({ id: "azure/gpt-4o-azure-live", provider: "azure", source: "provider" }),
      ]),
    );
    expect(catalog.models).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "openai/text-embedding-3-large" })]),
    );
    expect(catalog.models).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "openai/chatgpt-image-latest" })]),
    );
  });

  it("times out hung provider catalog requests", async () => {
    vi.useFakeTimers();
    process.env.OPENAI_API_KEY = "openai-key";
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const catalogPromise = listModelCatalog({ refresh: true });
    await vi.advanceTimersByTimeAsync(10_000);
    const catalog = await catalogPromise;

    expect(catalog.errors).toEqual([
      expect.objectContaining({
        provider: "openai",
        code: "provider_unavailable",
        message: expect.stringContaining("timed out"),
      }),
    ]);
  });
});
