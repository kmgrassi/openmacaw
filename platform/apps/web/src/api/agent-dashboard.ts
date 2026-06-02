import {
  AgentDashboardVersionResponseSchema,
  BrokerRunHistoryResponseSchema,
  BrokerTaskListResponseSchema,
  GatewayConfigStateResponseSchema,
  LatestBrokerRunResponseSchema,
  RUN_HISTORY_PAGE_SIZE,
  type BrokerRun,
  type BrokerTask,
  type GatewayConfigState,
} from "../../../../contracts/agent-dashboard";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export type RunHistoryPage = {
  runs: BrokerRun[];
  total: number;
};

export { RUN_HISTORY_PAGE_SIZE };
export type BrokerRunRow = BrokerRun;
export type BrokerTaskRow = BrokerTask;
export type GatewayConfigStateRow = GatewayConfigState;

export async function fetchAgentDashboardVersion(
  agentId: string,
  workspaceId?: string | null,
) {
  return apiFetch(ROUTES.agentDashboardVersion(agentId, workspaceId), {
    schema: AgentDashboardVersionResponseSchema,
    defaultErrorMessage: "Could not check dashboard updates",
  });
}

export async function fetchLatestBrokerRun(
  agentId: string,
): Promise<BrokerRun | null> {
  const response = await apiFetch(ROUTES.agentDashboardLatestRun(agentId), {
    schema: LatestBrokerRunResponseSchema,
    defaultErrorMessage: "Could not load latest run.",
  });
  return response.run;
}

export async function fetchBrokerRunHistory(
  agentId: string,
  page: number,
): Promise<RunHistoryPage> {
  return apiFetch(ROUTES.agentDashboardRuns(agentId, page), {
    schema: BrokerRunHistoryResponseSchema,
    defaultErrorMessage: "Could not load run history.",
  });
}

export async function fetchBrokerTasks(
  agentId: string,
  runIds: string[],
): Promise<BrokerTask[]> {
  if (runIds.length === 0) return [];
  const response = await apiFetch(ROUTES.agentDashboardTasks(agentId), {
    method: "POST",
    body: { runIds },
    schema: BrokerTaskListResponseSchema,
    defaultErrorMessage: "Could not load task history.",
  });
  return response.tasks;
}

export async function fetchGatewayConfigState(
  agentId: string,
  workspaceId?: string | null,
) {
  const response = await apiFetch(
    ROUTES.agentDashboardGatewayConfigState(agentId, workspaceId),
    {
      schema: GatewayConfigStateResponseSchema,
      defaultErrorMessage: "Could not load gateway config state.",
    },
  );
  return response.state;
}
