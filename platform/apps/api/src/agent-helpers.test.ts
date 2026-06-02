import { describe, expect, it } from "vitest";

import { asRecord, deriveProviderFromModel, extractPrimaryModel } from "../../../contracts/agent-helpers.js";
import { ModelSettingsSchema } from "../../../contracts/agents.js";

describe("agent helper contracts", () => {
  describe("asRecord", () => {
    it("returns objects and rejects null, arrays, and primitives", () => {
      const record = { primary: "openai/gpt-4.1" };

      expect(asRecord(record)).toBe(record);
      expect(asRecord(null)).toBeNull();
      expect(asRecord(["openai/gpt-4.1"])).toBeNull();
      expect(asRecord("openai/gpt-4.1")).toBeNull();
    });
  });

  describe("extractPrimaryModel", () => {
    it("extracts and trims a primary model", () => {
      expect(extractPrimaryModel({ primary: " openai/gpt-4.1 " })).toBe("openai/gpt-4.1");
    });

    it("returns null when the typed settings do not specify a primary model", () => {
      expect(extractPrimaryModel({})).toBeNull();
    });

    it("canonicalizes null settings and rejects invalid primary values at the schema boundary", () => {
      expect(ModelSettingsSchema.parse(null)).toEqual({});
      expect(ModelSettingsSchema.safeParse({ primary: "   " }).success).toBe(false);
      expect(ModelSettingsSchema.safeParse({ primary: 42 }).success).toBe(false);
    });
  });

  describe("deriveProviderFromModel", () => {
    it("returns the trimmed provider prefix before the first slash", () => {
      expect(deriveProviderFromModel(" openai/gpt-4.1 ")).toBe("openai");
      expect(deriveProviderFromModel("anthropic/claude-sonnet-4")).toBe("anthropic");
      expect(deriveProviderFromModel("openai_codex/gpt-5.3-codex")).toBe("openai_codex");
    });

    it("returns null when the model cannot provide a non-empty prefix", () => {
      expect(deriveProviderFromModel(null)).toBeNull();
      expect(deriveProviderFromModel("")).toBeNull();
      expect(deriveProviderFromModel(" /gpt-4.1")).toBeNull();
    });
  });
});
