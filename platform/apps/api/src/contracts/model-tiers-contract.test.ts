import { describe, expect, it } from "vitest";

import { MODEL_TIER_REGISTRY, modelRegistryEntry, modelTier } from "../../../../contracts/model-tiers.js";

describe("model tier registry contract", () => {
  it("classifies known frontier and wildcard local models", () => {
    expect(modelTier("anthropic", "anthropic/claude-opus-4-6")).toBe("frontier");
    expect(modelTier("anthropic", "claude-opus-4-7")).toBe("frontier");
    expect(modelTier("openai_compatible", "qwen-2.5")).toBe("local");
  });

  it("marks not-yet-executable adapter rollout entries", () => {
    const blocked = MODEL_TIER_REGISTRY.filter((entry) => !entry.executable);

    expect(blocked.map((entry) => entry.provider)).toContain("google");
    expect(modelRegistryEntry("google", "google/gemini-2.5-pro")).toMatchObject({
      tier: "frontier",
      executable: false,
    });
  });
});
