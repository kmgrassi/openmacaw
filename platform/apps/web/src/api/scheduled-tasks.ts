import {
  ScheduledTaskCancelResponseSchema,
  ScheduledTaskListResponseSchema,
  ScheduledTaskRunNowResponseSchema,
  type ScheduledTaskProjection,
} from "../../../../contracts/scheduled-tasks";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export async function listScheduledTasks(
  workspaceId: string,
  agentId: string,
): Promise<ScheduledTaskProjection[]> {
  const response = await apiFetch(
    ROUTES.workspaceScheduledTasks(workspaceId, agentId),
    {
      schema: ScheduledTaskListResponseSchema,
      defaultErrorMessage: "Could not load scheduled tasks",
    },
  );
  return response.scheduledTasks;
}

export async function cancelScheduledTask(input: {
  workspaceId: string;
  agentId: string;
  scheduledTaskId: string;
  reason?: string;
}): Promise<ScheduledTaskProjection> {
  const response = await apiFetch(
    ROUTES.scheduledTaskCancel(
      input.workspaceId,
      input.scheduledTaskId,
      input.agentId,
    ),
    {
      method: "POST",
      body: { reason: input.reason },
      schema: ScheduledTaskCancelResponseSchema,
      defaultErrorMessage: "Could not cancel scheduled task",
    },
  );
  return response.scheduledTask;
}

export async function runScheduledTaskNow(input: {
  workspaceId: string;
  agentId: string;
  scheduledTaskId: string;
}): Promise<ScheduledTaskProjection> {
  const response = await apiFetch(
    ROUTES.scheduledTaskRunNow(
      input.workspaceId,
      input.scheduledTaskId,
      input.agentId,
    ),
    {
      method: "POST",
      schema: ScheduledTaskRunNowResponseSchema,
      defaultErrorMessage: "Could not run scheduled task",
    },
  );
  return response.scheduledTask;
}
