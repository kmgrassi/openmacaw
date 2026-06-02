import type { AgentHealthResponse } from "../../../../../contracts/agent-health";
import type { Agent } from "../../hooks/useAgents";

export type WorkspaceAgentHealthProbe = {
  agentId: string;
  agentName: string;
  health: AgentHealthResponse | null;
  error: Error | null;
};

export type WorkspaceAgentHealthIssue = {
  agentId: string;
  agentName: string;
  status: "degraded" | "unhealthy" | "probe_failed";
  message: string;
};

export type WorkspaceAgentHealthSummary = {
  checkedCount: number;
  issueCount: number;
  firstIssue: WorkspaceAgentHealthIssue | null;
  issues: WorkspaceAgentHealthIssue[];
};

const ATTENTION_STATUSES = new Set(["degraded", "unhealthy"]);

export function workspaceAgents(
  agents: readonly Agent[],
  workspaceId: string | null | undefined,
): Agent[] {
  if (!workspaceId) return [];

  const seen = new Set<string>();
  return agents.filter((agent) => {
    if (agent.workspaceId !== workspaceId || seen.has(agent.id)) {
      return false;
    }
    seen.add(agent.id);
    return true;
  });
}

export function summarizeWorkspaceAgentHealth(
  probes: readonly WorkspaceAgentHealthProbe[],
): WorkspaceAgentHealthSummary {
  const issues: WorkspaceAgentHealthIssue[] = [];
  let checkedCount = 0;

  for (const probe of probes) {
    if (probe.health) {
      checkedCount += 1;
      if (ATTENTION_STATUSES.has(probe.health.status)) {
        issues.push({
          agentId: probe.agentId,
          agentName: probe.agentName,
          status: probe.health.status as "degraded" | "unhealthy",
          message:
            probe.health.lastFailure?.message ??
            `${probe.agentName} reported ${probe.health.status} health.`,
        });
      }
      continue;
    }

    if (probe.error) {
      checkedCount += 1;
      issues.push({
        agentId: probe.agentId,
        agentName: probe.agentName,
        status: "probe_failed",
        message: probe.error.message || "Agent health probe failed.",
      });
    }
  }

  return {
    checkedCount,
    issueCount: issues.length,
    firstIssue: issues[0] ?? null,
    issues,
  };
}
