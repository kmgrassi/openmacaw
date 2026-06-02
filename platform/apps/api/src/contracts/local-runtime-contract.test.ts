import { describe, expect, it } from "vitest";

import { LocalRuntimeRegistrationRequestSchema } from "../../../../contracts/local-runtime.js";

describe("local runtime contract", () => {
  it("rejects local model providers outside the execution provider enum", () => {
    expect(
      LocalRuntimeRegistrationRequestSchema.safeParse({
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "ollama",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("defaults openai_compatible runner provider to the OpenAI-compatible value", () => {
    const parsed = LocalRuntimeRegistrationRequestSchema.parse({
      runners: [
        {
          kind: "openai_compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          model: "qwen3-coder:30b",
        },
      ],
    });
    const first = parsed.runners[0]!;
    if (first.kind !== "openai_compatible") {
      throw new Error("Expected discriminator to narrow to openai_compatible");
    }
    expect(first.provider).toBe("openai_compatible");
  });

  it("accepts an openclaw-only registration with just an endpoint", () => {
    const parsed = LocalRuntimeRegistrationRequestSchema.parse({
      runners: [
        {
          kind: "openclaw",
          endpoint: "http://localhost:7100",
        },
      ],
    });
    const first = parsed.runners[0]!;
    expect(first.kind).toBe("openclaw");
    expect(first.endpoint).toBe("http://localhost:7100");
  });

  it("accepts a multi-kind registration carrying both openai_compatible and openclaw runners", () => {
    const parsed = LocalRuntimeRegistrationRequestSchema.parse({
      runners: [
        {
          kind: "openai_compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          model: "qwen3-coder:30b",
        },
        {
          kind: "openclaw",
          endpoint: "http://localhost:7100",
          apiKey: "sk-openclaw",
        },
      ],
    });
    expect(parsed.runners).toHaveLength(2);
    expect(parsed.runners.map((runner) => runner.kind).sort()).toEqual(["openai_compatible", "openclaw"]);
  });

  it("rejects a registration with duplicate runner kinds", () => {
    expect(
      LocalRuntimeRegistrationRequestSchema.safeParse({
        runners: [
          { kind: "openclaw", endpoint: "http://localhost:7100" },
          { kind: "openclaw", endpoint: "http://localhost:7200" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a registration with no runners", () => {
    expect(LocalRuntimeRegistrationRequestSchema.safeParse({ runners: [] }).success).toBe(false);
  });
});
