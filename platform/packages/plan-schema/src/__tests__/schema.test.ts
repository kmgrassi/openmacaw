import { describe, expect, it } from "vitest";

import rawPlanSchemaV1 from "../../v1.json" with { type: "json" };
import { planSchemaV1, toPlanJsonSchemaV1, validatePlan, type PlanV1, type PlanValidationError } from "../index.js";

const canonicalPlan = {
  schemaVersion: "1",
  title: "Clean up unused imports in src/",
  intent: "Clean up unused imports across the source tree.",
  defaultRunner: "codex",
  defaultModel: "gpt-5.1",
  tasks: [
    {
      id: "t-components",
      title: "Clean up src/components/",
      instructions: "Remove unused imports from React components and keep behavior unchanged.",
      labels: {
        directory: "src/components",
      },
      dependsOn: [],
      completionGates: ["lint", "tests"],
    },
    {
      id: "t-api",
      title: "Clean up API routes",
      instructions: "Remove unused imports from API route modules and keep public contracts unchanged.",
      labels: {
        directory: "apps/api/src/routes",
      },
      dependsOn: ["t-components"],
      completionGates: ["lint", "self-review"],
    },
  ],
} satisfies PlanV1;

describe("plan schema v1", () => {
  it("accepts a canonical plan document", () => {
    expect(validatePlan(canonicalPlan)).toEqual({ ok: true, plan: canonicalPlan, errors: [] });
  });

  it("accepts a minimal valid plan document", () => {
    const result = validatePlan({
      schemaVersion: "1",
      title: "Build the smallest valid plan",
      intent: "Create the minimum valid plan shape.",
      tasks: [
        {
          id: "t-01",
          title: "Do the work",
          instructions: "Complete the requested change.",
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts local model coding as a default runner", () => {
    const result = validatePlan({
      ...canonicalPlan,
      defaultRunner: "local_model_coding",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects missing required top-level fields", () => {
    const result = validatePlan({ ...canonicalPlan, title: undefined });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("invalid_type");
  });

  it("rejects unsupported schema versions", () => {
    const result = validatePlan({ ...canonicalPlan, schemaVersion: "2" });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("invalid_value");
  });

  it("rejects unsupported default runners", () => {
    const result = validatePlan({ ...canonicalPlan, defaultRunner: "shell" });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("invalid_value");
  });

  it("rejects empty task lists", () => {
    const result = validatePlan({ ...canonicalPlan, tasks: [] });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("too_small");
  });

  it("rejects malformed task ids", () => {
    const result = validatePlan({
      ...canonicalPlan,
      tasks: [{ ...canonicalPlan.tasks[0], id: "task-01" }],
    });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("invalid_format");
  });

  it("rejects non-string label values", () => {
    const result = validatePlan({
      ...canonicalPlan,
      tasks: [{ ...canonicalPlan.tasks[0], labels: { priority: 1 } }],
    });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("invalid_type");
  });

  it("rejects unknown dependency ids", () => {
    const result = validatePlan({
      ...canonicalPlan,
      tasks: [{ ...canonicalPlan.tasks[0], dependsOn: ["t-missing"] }],
    });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("known_task_dependency");
  });

  it("rejects duplicate task ids", () => {
    const result = validatePlan({
      ...canonicalPlan,
      tasks: [
        { ...canonicalPlan.tasks[0], id: "t-duplicate" },
        { ...canonicalPlan.tasks[1], id: "t-duplicate", dependsOn: [] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("unique_task_id");
  });

  it("rejects unsupported completion gates", () => {
    const result = validatePlan({
      ...canonicalPlan,
      tasks: [{ ...canonicalPlan.tasks[0], completionGates: ["deploy"] }],
    });

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("invalid_value");
  });

  it("serializes deterministically", () => {
    expect(`${JSON.stringify(planSchemaV1, null, 2)}\n`).toMatchSnapshot();
  });

  it("matches the raw JSON schema export", () => {
    expect(planSchemaV1).toEqual(rawPlanSchemaV1);
  });

  it("keeps the raw JSON schema aligned with the Zod schema", () => {
    expect(planSchemaV1).toEqual(toPlanJsonSchemaV1());
  });
});

function errorCodes(result: ReturnType<typeof validatePlan>): string[] {
  return result.ok ? [] : result.errors.map((error: PlanValidationError) => error.code);
}
