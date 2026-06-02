import { z } from "zod";

export const PlannerEvidenceSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().nullable(),
  snippet: z.string().nullable(),
  label: z.string().nullable(),
});

export const PlanReviewTaskSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  plan_id: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  state: z.string().nullable(),
  priority: z.string().nullable(),
  labels: z.unknown().nullable(),
  metadata: z.unknown().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  evidence: z.array(PlannerEvidenceSchema),
});

export const PlanReviewPlanSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  tasks: z.array(PlanReviewTaskSchema),
  evidence: z.array(PlannerEvidenceSchema),
});

export const PlanReviewListResponseSchema = z.object({
  plans: z.array(PlanReviewPlanSchema),
});

export type PlannerEvidence = z.infer<typeof PlannerEvidenceSchema>;
export type PlanReviewTask = z.infer<typeof PlanReviewTaskSchema>;
export type PlanReviewPlan = z.infer<typeof PlanReviewPlanSchema>;
export type PlanReviewListResponse = z.infer<
  typeof PlanReviewListResponseSchema
>;
