import { z } from "zod";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export const COMPLETION_GATES = [
  "lint",
  "tests",
  "peer-review",
  "self-review",
] as const;

export type CompletionGate = (typeof COMPLETION_GATES)[number];

export type PlanTaskDraft = {
  id: string;
  title: string;
  instructions: string;
  labels: Record<string, string>;
  dependsOn: string[];
  completionGates: CompletionGate[];
};

export type PlanDraft = {
  schemaVersion: "1";
  title: string;
  intent: string;
  defaultRunner?: string;
  defaultModel?: string;
  tasks: PlanTaskDraft[];
};

export type PlanRecord = {
  id: string;
  workspaceId?: string | null;
  name: string | null;
  description: string | null;
  status: string | null;
  metadata?: unknown;
  schemaVersion?: string | null;
  intent?: string | null;
  defaultRunnerKind?: string | null;
  defaultModel?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WorkItemProjection = {
  id: string;
  taskId?: string | null;
  workspaceId?: string | null;
  planId: string | null;
  identifier?: string | null;
  title: string | null;
  description: string | null;
  instructions?: string | null;
  state: string | null;
  priority: string | null;
  source?: string | null;
  runnerKind?: string | null;
  repository?: string | null;
  labels: string[] | null;
  dependsOn?: string[];
  completionGates?: string[];
  metadata: unknown;
  nextPollAt?: string | null;
  lastPolledAt?: string | null;
  pollCadenceSeconds?: number | null;
  snooze?: WorkItemSnooze | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type WorkItemSnoozeActor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string };

export type WorkItemSnooze = {
  indefinite: boolean;
  reason: string | null;
  snoozedAt: string;
  snoozedBy: WorkItemSnoozeActor;
};

const completionGateSchema = z.enum(COMPLETION_GATES);

export const planTaskDraftSchema = z.object({
  id: z.string().regex(/^t-[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1),
  labels: z.record(z.string(), z.string()).default({}),
  dependsOn: z.array(z.string()).default([]),
  completionGates: z.array(completionGateSchema).default([]),
});

export const planDraftSchema = z.object({
  schemaVersion: z.literal("1").default("1"),
  title: z.string().trim().min(1).max(200),
  intent: z.string().trim().min(1),
  defaultRunner: z.string().optional(),
  defaultModel: z.string().optional(),
  tasks: z.array(planTaskDraftSchema).min(1),
});

const planRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable().optional().default(null),
  name: z.string().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  status: z.string().nullable().optional().default(null),
  metadata: z.unknown().optional(),
  schemaVersion: z.string().nullable().optional().default(null),
  intent: z.string().nullable().optional().default(null),
  defaultRunnerKind: z.string().nullable().optional().default(null),
  defaultModel: z.string().nullable().optional().default(null),
  createdAt: z.string().nullable().optional().default(null),
  updatedAt: z.string().nullable().optional().default(null),
});

const workItemProjectionSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable().optional().default(null),
  workspaceId: z.string().nullable().optional().default(null),
  planId: z.string().nullable().optional().default(null),
  identifier: z.string().nullable().optional().default(null),
  title: z.string().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  instructions: z.string().nullable().optional().default(null),
  state: z.string().nullable().optional().default(null),
  priority: z.string().nullable().optional().default(null),
  source: z.string().nullable().optional().default(null),
  runnerKind: z.string().nullable().optional().default(null),
  repository: z.string().nullable().optional().default(null),
  labels: z.array(z.string()).nullable().optional().default(null),
  dependsOn: z.array(z.string()).optional().default([]),
  completionGates: z.array(z.string()).optional().default([]),
  metadata: z.unknown(),
  nextPollAt: z.string().nullable().optional().default(null),
  lastPolledAt: z.string().nullable().optional().default(null),
  pollCadenceSeconds: z.number().nullable().optional().default(null),
  snooze: z
    .object({
      indefinite: z.boolean(),
      reason: z.string().nullable().optional().default(null),
      snoozedAt: z.string(),
      snoozedBy: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("user"), userId: z.string() }),
        z.object({ kind: z.literal("agent"), agentId: z.string() }),
      ]),
    })
    .nullable()
    .optional()
    .default(null),
  createdAt: z.string().nullable().optional().default(null),
  updatedAt: z.string().nullable().optional().default(null),
});

const draftFromPromptResponseSchema = z.object({
  draft: planDraftSchema,
});

const createPlanResponseSchema = z.object({
  plan: planRecordSchema,
  workItems: z.array(workItemProjectionSchema),
});

const listPlansResponseSchema = z.object({
  plans: z.array(planRecordSchema),
});

const listWorkItemsResponseSchema = z.object({
  workItems: z.array(workItemProjectionSchema),
});

const deletePlanResponseSchema = z.object({
  deleted: z.literal(true),
  plan: planRecordSchema,
});

const deleteWorkItemResponseSchema = z.object({
  deleted: z.literal(true),
  workItem: workItemProjectionSchema,
});

export type DraftFromPromptResponse = z.infer<
  typeof draftFromPromptResponseSchema
>;
export type CreatePlanResponse = z.infer<typeof createPlanResponseSchema>;
export type ListPlansResponse = z.infer<typeof listPlansResponseSchema>;
export type ListWorkItemsResponse = z.infer<typeof listWorkItemsResponseSchema>;
export type DeletePlanResponse = z.infer<typeof deletePlanResponseSchema>;
export type DeleteWorkItemResponse = z.infer<
  typeof deleteWorkItemResponseSchema
>;

export function draftPlanFromPrompt(input: {
  workspaceId: string;
  prompt: string;
  defaultRunner?: string;
  defaultModel?: string;
}): Promise<DraftFromPromptResponse> {
  return apiFetch(ROUTES.planDraftFromPrompt, {
    method: "POST",
    body: input,
    schema: draftFromPromptResponseSchema,
    defaultErrorMessage: "Could not draft a plan from that prompt.",
  });
}

export function createPlan(
  workspaceId: string,
  draft: PlanDraft,
): Promise<CreatePlanResponse> {
  return apiFetch(ROUTES.plans, {
    method: "POST",
    body: {
      workspaceId,
      ...planDraftSchema.parse(draft),
    },
    schema: createPlanResponseSchema,
    defaultErrorMessage: "Could not create the plan.",
  });
}

export function listPlans(workspaceId: string): Promise<ListPlansResponse> {
  return apiFetch(ROUTES.workspacePlans(workspaceId), {
    schema: listPlansResponseSchema,
    defaultErrorMessage: "Could not load plans.",
  });
}

export function deletePlan(
  workspaceId: string,
  planId: string,
): Promise<DeletePlanResponse> {
  return apiFetch(ROUTES.workspacePlan(workspaceId, planId), {
    method: "DELETE",
    schema: deletePlanResponseSchema,
    defaultErrorMessage: "Could not delete the plan.",
  });
}

export function listWorkItems(
  workspaceId: string,
): Promise<ListWorkItemsResponse> {
  return apiFetch(ROUTES.workspaceWorkItems(workspaceId), {
    schema: listWorkItemsResponseSchema,
    defaultErrorMessage: "Could not load work items.",
  });
}

export function deleteWorkItem(
  workspaceId: string,
  workItemId: string,
): Promise<DeleteWorkItemResponse> {
  return apiFetch(ROUTES.workspaceWorkItem(workspaceId, workItemId), {
    method: "DELETE",
    schema: deleteWorkItemResponseSchema,
    defaultErrorMessage: "Could not delete the work item.",
  });
}

export function normalizeDraft(value: PlanDraft): PlanDraft {
  return planDraftSchema.parse(value);
}
