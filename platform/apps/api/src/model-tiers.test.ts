import { describe, expect, it } from "vitest";

import { MODEL_TIER_REGISTRY, modelTier, type RegisteredProvider } from "../../../contracts/model-tiers.js";

describe("model tier registry", () => {
  it("classifies explicit frontier models", () => {
    expect(modelTier("anthropic", "claude-opus-4-7")).toBe("frontier");
  });

  it("falls back to the provider wildcard for local OpenAI-compatible models", () => {
    expect(modelTier("openai_compatible", "qwen-2.5")).toBe("local");
  });

  it("prefers explicit entries over provider wildcards", () => {
    expect(modelTier("openai_compatible", "qwen2.5-coder-32b")).toBe("mid");
  });

  it("returns null for unknown non-wildcard providers", () => {
    expect(modelTier("openai", "unknown-model")).toBeNull();
  });

  it("only uses registered provider ids", () => {
    const providers = new Set<RegisteredProvider>(MODEL_TIER_REGISTRY.map((entry) => entry.provider));

    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("openai_compatible")).toBe(true);
  });
});
