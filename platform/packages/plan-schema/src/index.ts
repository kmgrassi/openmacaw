import { z } from "zod";

import rawPlanSchemaV1 from "../v1.json" with { type: "json" };

export const COMPLETION_GATES = ["lint", "tests", "peer-review", "self-review"] as const;
export const DEFAULT_RUNNERS = [
  "codex",
  "openclaw",
  "computer_use",
  "openai_compatible",
  "local_model_coding",
] as const;

const taskIdSchema = z.string().regex(/^t-[a-z0-9-]+$/);

export const PlanTaskSchemaV1 = z
  .object({
    id: taskIdSchema,
    title: z.string().min(1).max(120),
    instructions: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    dependsOn: z.array(taskIdSchema).optional(),
    completionGates: z.array(z.enum(COMPLETION_GATES)).optional(),
  })
  .strict();

export const PlanSchemaV1 = z
  .object({
    schemaVersion: z.literal("1"),
    title: z.string().min(1).max(200),
    intent: z.string().min(1),
    defaultRunner: z.enum(DEFAULT_RUNNERS).optional(),
    defaultModel: z.string().min(1).optional(),
    tasks: z.array(PlanTaskSchemaV1).min(1),
  })
  .strict();

export const planSchemaV1 = rawPlanSchemaV1;

export type PlanV1 = z.infer<typeof PlanSchemaV1>;
export type PlanTaskV1 = z.infer<typeof PlanTaskSchemaV1>;
export type PlanJsonSchemaV1 = typeof rawPlanSchemaV1;

export type PlanValidationError = {
  path: Array<string | number>;
  code: string;
  message: string;
};

export type PlanValidationResult =
  | { ok: true; plan: PlanV1; errors: [] }
  | { ok: false; errors: PlanValidationError[] };

export function validatePlan(input: unknown): PlanValidationResult {
  const parsed = PlanSchemaV1.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  const semanticErrors = validateTaskReferences(parsed.data);

  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors };
  }

  return { ok: true, plan: parsed.data, errors: [] };
}

export function toPlanJsonSchemaV1(): PlanJsonSchemaV1 {
  return withPlanSchemaMetadata(z.toJSONSchema(PlanSchemaV1, { target: "draft-7" }));
}

function validateTaskReferences(input: PlanV1): PlanValidationError[] {
  const taskIds = new Set<string>();
  const errors: PlanValidationError[] = [];

  input.tasks.forEach((task, index) => {
    if (taskIds.has(task.id)) {
      errors.push(createValidationError(["tasks", index, "id"], "duplicate task id", "unique_task_id"));
    }

    taskIds.add(task.id);
  });

  input.tasks.forEach((task, taskIndex) => {
    task.dependsOn?.forEach((dependencyId, dependencyIndex) => {
      if (!taskIds.has(dependencyId)) {
        errors.push(
          createValidationError(
            ["tasks", taskIndex, "dependsOn", dependencyIndex],
            "dependsOn must reference another task id in the same plan",
            "known_task_dependency",
          ),
        );
      }
    });
  });

  return errors;
}

function createValidationError(path: Array<string | number>, message: string, code: string): PlanValidationError {
  return { path, code, message };
}

function withPlanSchemaMetadata(schema: unknown): PlanJsonSchemaV1 {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://schemas.harper.dev/plan/v1.json",
    title: "Harper Plan v1",
    description: "Canonical plan document emitted by the planning agent and accepted by the platform plans API.",
    ...(schema as Record<string, unknown>),
  } as unknown as PlanJsonSchemaV1;
}
