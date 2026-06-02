import { describe, expect, it } from "vitest";

import {
  SkillCandidatePrCreateRequestSchema,
  SkillCandidatePrCreateResponseSchema,
} from "../../../../contracts/learning-skill-prs.js";

describe("learning skill PR contracts", () => {
  it("accepts a valid skill candidate PR request", () => {
    expect(
      SkillCandidatePrCreateRequestSchema.parse({
        candidateMemoryId: "22222222-2222-4222-8222-222222222222",
        repository: "kmgrassi/parallel-agent-platform",
        slug: "api-validation-workflow",
        baseBranch: "main",
      }),
    ).toEqual({
      candidateMemoryId: "22222222-2222-4222-8222-222222222222",
      repository: "kmgrassi/parallel-agent-platform",
      slug: "api-validation-workflow",
      baseBranch: "main",
    });
  });

  it("rejects non-kebab-case skill slugs", () => {
    expect(() =>
      SkillCandidatePrCreateRequestSchema.parse({
        candidateMemoryId: "22222222-2222-4222-8222-222222222222",
        slug: "API validation workflow",
      }),
    ).toThrow();
  });

  it("accepts the create response shape", () => {
    expect(
      SkillCandidatePrCreateResponseSchema.parse({
        candidateMemoryId: "22222222-2222-4222-8222-222222222222",
        sourceMemoryIds: ["33333333-3333-4333-8333-333333333333"],
        pullRequest: {
          url: "https://github.com/kmgrassi/parallel-agent-platform/pull/123",
          number: 123,
          repository: "kmgrassi/parallel-agent-platform",
          branch: "codex/skill-candidate-api-validation-workflow-22222222",
          baseBranch: "main",
          skillPath: ".codex/skills/api-validation-workflow.md",
        },
      }),
    ).toMatchObject({
      pullRequest: {
        number: 123,
        skillPath: ".codex/skills/api-validation-workflow.md",
      },
    });
  });
});
