import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { fetchAgentHealth } from "../../api/setup";
import { queryKeys } from "../../api/query-keys";
import type { Agent } from "../../hooks/useAgents";
import { useAuthStore } from "../../stores/auth";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import {
  summarizeWorkspaceAgentHealth,
  workspaceAgents,
} from "./workspace-agent-health";
import type { AgentHealthResponse } from "../../../../../contracts/agent-health";

const WORKSPACE_HEALTH_STALE_TIME_MS = 30_000;

type WorkspaceAgentHealthBannerProps = {
  agents: readonly Agent[];
};

export function WorkspaceAgentHealthBanner({
  agents,
}: WorkspaceAgentHealthBannerProps) {
  const navigate = useNavigate();
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const [dismissedWorkspaceId, setDismissedWorkspaceId] = useState<
    string | null
  >(null);

  useEffect(() => {
    setDismissedWorkspaceId(null);
  }, [workspaceId]);

  const agentsInWorkspace = useMemo(
    () => workspaceAgents(agents, workspaceId),
    [agents, workspaceId],
  );

  const healthQueries = useQueries({
    queries: agentsInWorkspace.map((agent) => ({
      queryKey: queryKeys.agentHealth.detail(agent.id),
      queryFn: () => fetchAgentHealth(agent.id),
      enabled: Boolean(workspaceId),
      staleTime: WORKSPACE_HEALTH_STALE_TIME_MS,
      retry: false,
    })),
  });

  const summary = useMemo(
    () =>
      summarizeWorkspaceAgentHealth(
        agentsInWorkspace.map((agent, index) => {
          const query = healthQueries[index];
          return {
            agentId: agent.id,
            agentName: agent.name || agent.id,
            health: (query?.data as AgentHealthResponse | undefined) ?? null,
            error: (query?.error as Error | null) ?? null,
          };
        }),
      ),
    [agentsInWorkspace, healthQueries],
  );

  if (
    !workspaceId ||
    agentsInWorkspace.length === 0 ||
    summary.issueCount === 0 ||
    dismissedWorkspaceId === workspaceId
  ) {
    return null;
  }

  const title =
    summary.issueCount === 1
      ? "1 agent needs attention"
      : `${summary.issueCount} agents need attention`;
  const firstIssue = summary.firstIssue;

  return (
    <div className="border-b border-amber-800/40 bg-slate-950 px-4 py-3 sm:px-5">
      <Alert
        tone="warning"
        title={title}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                if (firstIssue) {
                  navigate(`/dashboard/${firstIssue.agentId}`);
                }
              }}
              disabled={!firstIssue}
            >
              View diagnostics
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-amber-100 hover:bg-amber-900/20"
              onClick={() => setDismissedWorkspaceId(workspaceId)}
            >
              Dismiss
            </Button>
          </div>
        }
      >
        {firstIssue
          ? `${firstIssue.agentName}: ${firstIssue.message}`
          : "Agent health checks found workspace issues."}
      </Alert>
    </div>
  );
}
