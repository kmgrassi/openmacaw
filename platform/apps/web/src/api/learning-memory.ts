import {
  LearningMemoryStatusResponseSchema,
  type LearningMemoryStatusResponse,
  type LearningProviderWarningTelemetryRequest,
} from "../../../../contracts/learning-memory";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export async function getLearningMemoryStatus(
  workspaceId: string,
): Promise<LearningMemoryStatusResponse> {
  return apiFetch(ROUTES.workspaceLearningMemoryStatus(workspaceId), {
    schema: LearningMemoryStatusResponseSchema,
    defaultErrorMessage: "Could not load learning memory status",
  });
}

export async function recordLearningProviderWarningEvent(
  input: LearningProviderWarningTelemetryRequest,
): Promise<void> {
  await apiFetch(
    ROUTES.workspaceLearningProviderWarningEvents(input.workspaceId),
    {
      method: "POST",
      body: input,
      defaultErrorMessage: "Could not record learning provider warning event",
    },
  );
}
