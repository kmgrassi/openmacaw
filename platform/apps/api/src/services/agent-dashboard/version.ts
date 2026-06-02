import {
  DASHBOARD_VERSION_POLL_MS,
  getGatewayConfigVersionRows,
  getLatestAgentToolCallEvent,
  getLatestBrokerTask,
  getRecentBrokerRuns,
} from "../../repositories/agent-dashboard.js";
import { assertDashboardAccess } from "./access.js";
import { latestTimestamp } from "./sanitize.js";

export async function getAgentDashboardVersion(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}) {
  const { workspaceId } = await assertDashboardAccess(input);
  const runs = await getRecentBrokerRuns(input.agentId);
  const runIds = runs.map((run) => run.run_id);
  const [latestTask, latestToolEvent] = await Promise.all([
    getLatestBrokerTask(runIds),
    getLatestAgentToolCallEvent(runIds),
  ]);
  const configRows = await getGatewayConfigVersionRows(input.agentId, workspaceId);
  const latestRun = runs[0] ?? null;

  const latestConfigAt = latestTimestamp(...configRows.flatMap((row) => [row.last_apply_at, row.synced_at]));
  const latestEventAt = latestTimestamp(
    latestRun?.updated_at,
    latestRun?.created_at,
    latestTask?.updated_at,
    latestTask?.last_event_at,
    latestToolEvent?.updated_at,
    latestToolEvent?.created_at,
    latestConfigAt,
  );

  return {
    version: JSON.stringify({
      latestRun: latestRun ? [latestRun.run_id, latestRun.updated_at, latestRun.created_at] : null,
      latestTask: latestTask ? [latestTask.task_id, latestTask.updated_at, latestTask.last_event_at] : null,
      latestToolEvent: latestToolEvent
        ? [latestToolEvent.id, latestToolEvent.updated_at, latestToolEvent.created_at]
        : null,
      config: configRows.map((row) => [
        row.scope_type,
        row.scope_id,
        row.sync_status,
        row.sync_error,
        row.last_apply_status,
        row.last_apply_error,
        row.last_apply_at,
        row.last_applied_version,
        row.synced_at,
      ]),
    }),
    latestEventAt: latestEventAt,
    pollAfterMs: DASHBOARD_VERSION_POLL_MS,
  };
}
