import {
  PlanReviewListResponseSchema,
  type PlanReviewPlan,
} from "../../../../contracts/plans";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export async function fetchPlanReviews(
  workspaceId: string,
): Promise<PlanReviewPlan[]> {
  const response = await apiFetch(ROUTES.planReviews(workspaceId), {
    schema: PlanReviewListResponseSchema,
    defaultErrorMessage: "Could not load plan reviews",
  });

  return response.plans;
}

export type { PlanReviewPlan } from "../../../../contracts/plans";
