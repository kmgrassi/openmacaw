import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractModelTierRegistry,
  renderElixirModelTiers,
} from "./generate-runtime-model-tiers.mjs";

test("extracts model tier entries from the TypeScript contract", () => {
  const entries = extractModelTierRegistry(`
export const MODEL_TIER_REGISTRY: ReadonlyArray<{
  provider: RegisteredProvider;
  model: string;
  tier: AssignableModelTier;
}> = [
  { provider: "anthropic", model: "claude-opus-4-7", tier: "frontier" },
  {
    provider: "openai_compatible",
    model: "*",
    tier: "local",
  },
] as const;
`);

  assert.deepEqual(entries, [
    {
      provider: "anthropic",
      model: "claude-opus-4-7",
      tier: "frontier",
    },
    { provider: "openai_compatible", model: "*", tier: "local" },
  ]);
});

test("extracts valid entries when fields are reordered", () => {
  const entries = extractModelTierRegistry(`
export const MODEL_TIER_REGISTRY: ReadonlyArray<{
  provider: RegisteredProvider;
  model: string;
  tier: AssignableModelTier;
}> = [
  { provider: "openai", tier: "mid", model: "gpt-4.1-mini" },
] as const;
`);

  assert.deepEqual(entries, [
    { provider: "openai", model: "gpt-4.1-mini", tier: "mid" },
  ]);
});

test("rejects malformed registry entries instead of omitting them", () => {
  assert.throws(
    () =>
      extractModelTierRegistry(`
export const MODEL_TIER_REGISTRY: ReadonlyArray<{
  provider: RegisteredProvider;
  model: string;
  tier: AssignableModelTier;
}> = [
  { provider: "openai", model: "gpt-4.1-mini" },
] as const;
`),
    /Malformed MODEL_TIER_REGISTRY entry/,
  );
});

test("renders an Elixir mirror with exact and wildcard lookup", () => {
  const output = renderElixirModelTiers([
    {
      provider: "anthropic",
      model: "claude-opus-4-7",
      tier: "frontier",
    },
    { provider: "openai_compatible", model: "*", tier: "local" },
  ]);

  assert.match(output, /defmodule SymphonyElixir\.ModelTiers do/);
  assert.match(output, /\{"anthropic", "claude-opus-4-7", :frontier\}/);
  assert.match(output, /\{"openai_compatible", "\*", :local\}/);
  assert.match(output, /exact \|\| wildcard/);
});

test("rejects wildcard entries outside openai_compatible", () => {
  assert.throws(
    () =>
      renderElixirModelTiers([
        { provider: "openai", model: "*", tier: "local" },
      ]),
    /Only openai_compatible may use a wildcard model/,
  );
});
