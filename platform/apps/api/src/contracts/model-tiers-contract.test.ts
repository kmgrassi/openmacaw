import { describe, expect, it } from "vitest";

import {
  MODEL_TIER_REGISTRY,
  modelRegistryEntry,
  modelTier,
  type RegisteredModelTier,
} from "../../../../contracts/model-tiers.js";

describe("model tier registry contract", () => {
  it("classifies known frontier and wildcard local models", () => {
    expect(modelTier("anthropic", "claude-opus-4-7")).toBe("frontier");
    expect(modelTier("openai_compatible", "qwen-2.5")).toBe("local");
  });

  it("marks not-yet-executable adapter rollout entries", () => {
    const blocked = MODEL_TIER_REGISTRY.map((entry) => modelRegistryEntry(entry.provider, entry.model)).filter(
      (entry): entry is RegisteredModelTier => entry !== null && !entry.executable,
    );

    expect(blocked.map((entry) => entry.provider)).toContain("google");
    expect(modelRegistryEntry("google", "gemini-2.5-pro")).toMatchObject({
      tier: "frontier",
      executable: false,
    });
  });
});
