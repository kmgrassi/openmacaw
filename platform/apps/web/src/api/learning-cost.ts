import {
  LearningCostResponseSchema,
  type LearningCostResponse,
} from "../../../../contracts/learning-cost";
import { apiFetch } from "./client";

export async function fetchLearningCost(input: {
  workspaceId: string;
  startDate: string;
  endDate: string;
}): Promise<LearningCostResponse> {
  const params = new URLSearchParams({
    startDate: input.startDate,
    endDate: input.endDate,
  });
  return apiFetch(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/learning-cost?${params.toString()}`,
    {
      schema: LearningCostResponseSchema,
    },
  );
}
