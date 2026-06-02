import { z } from "zod";

export const PlanCompletionGateSchema = z.enum([
  "lint",
  "tests",
  "peer-review",
  "self-review",
]);

export const PlanRunnerKindSchema = z.enum([
  "codex",
  "openclaw",
  "computer_use",
  "openai_compatible",
  "local_model_coding",
]);

export const PlanTaskSchema = z.object({
  id: z.string().regex(/^t-[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1),
  labels: z.record(z.string(), z.string()).default({}),
  dependsOn: z.array(z.string().regex(/^t-[a-z0-9-]+$/)).default([]),
  completionGates: z.array(PlanCompletionGateSchema).default([]),
});

export const PlanBodySchema = z
  .object({
    schemaVersion: z.literal("1").default("1"),
    title: z.string().trim().min(1).max(200),
    intent: z.string().trim().min(1),
    defaultRunner: PlanRunnerKindSchema.optional(),
    defaultModel: z.string().trim().min(1).optional(),
    tasks: z.array(PlanTaskSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const taskIds = new Set<string>();
    for (const [index, task] of value.tasks.entries()) {
      if (taskIds.has(task.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "id"],
          message: `Duplicate task id ${task.id}`,
        });
      }
      taskIds.add(task.id);
    }

    for (const [index, task] of value.tasks.entries()) {
      for (const dependencyId of task.dependsOn) {
        if (!taskIds.has(dependencyId)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "dependsOn"],
            message: `Unknown dependency ${dependencyId}`,
          });
        }
      }
    }
  });

export const PlanRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  schemaVersion: z.string(),
  intent: z.string().nullable(),
  defaultRunnerKind: z.string().nullable(),
  defaultModel: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PlanDraftFromPromptRequestSchema = z.object({
  workspaceId: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  defaultRunner: PlanRunnerKindSchema.optional(),
  defaultModel: z.string().trim().min(1).optional(),
});

export const PlanDraftFromPromptResponseSchema = z.object({
  draft: PlanBodySchema,
});

export const PlannerEvidenceSchema = z.object({
  path: z.string(),
  line: z.number().nullable(),
  snippet: z.string().nullable(),
  label: z.string().nullable(),
});

export const PlanReviewTaskSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  planId: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  state: z.string(),
  priority: z.string().nullable(),
  labels: z.array(z.string()),
  metadata: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
  evidence: z.array(PlannerEvidenceSchema),
});

export const PlanReviewPlanSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string(),
  type: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tasks: z.array(PlanReviewTaskSchema),
  evidence: z.array(PlannerEvidenceSchema),
});

export const PlanReviewListResponseSchema = z.object({
  plans: z.array(PlanReviewPlanSchema),
});

export const PlanListResponseSchema = z.object({
  plans: z.array(PlanRecordSchema),
});

export const PlanDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  plan: PlanRecordSchema,
});

export type PlanBody = z.infer<typeof PlanBodySchema>;
export type PlanRecord = z.infer<typeof PlanRecordSchema>;
export type PlanDraftFromPromptRequest = z.infer<
  typeof PlanDraftFromPromptRequestSchema
>;
export type PlanDraftFromPromptResponse = z.infer<
  typeof PlanDraftFromPromptResponseSchema
>;
export type PlannerEvidence = z.infer<typeof PlannerEvidenceSchema>;
export type PlanReviewTask = z.infer<typeof PlanReviewTaskSchema>;
export type PlanReviewPlan = z.infer<typeof PlanReviewPlanSchema>;
export type PlanReviewListResponse = z.infer<
  typeof PlanReviewListResponseSchema
>;
export type PlanListResponse = z.infer<typeof PlanListResponseSchema>;
export type PlanDeleteResponse = z.infer<typeof PlanDeleteResponseSchema>;
