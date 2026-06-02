import {
  WorkspaceAgentDiagnosticResponseSchema,
  WorkspaceAgentDiagnosticRuntimeResponseSchema,
  type WorkspaceAgentDiagnosticResponse,
} from "../../../../../contracts/agent-health.js";
import { errorMessage, logEvent } from "../../logger.js";
import type { UpstreamResponse } from "../upstream.js";

type RuntimeRequester = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

function runtimeDiagnosticPath(workspaceId: string) {
  return `/api/v1/diagnostic/workspace/${encodeURIComponent(workspaceId)}/agents`;
}

function unreachable(details: string): WorkspaceAgentDiagnosticResponse {
  return WorkspaceAgentDiagnosticResponseSchema.parse({
    ok: false,
    reason: "runtime_unreachable",
    details,
  });
}

export async function loadWorkspaceAgentDiagnostic(
  workspaceId: string,
  runtimeRequest: RuntimeRequester,
): Promise<WorkspaceAgentDiagnosticResponse> {
  let response: UpstreamResponse;

  try {
    response = await runtimeRequest(runtimeDiagnosticPath(workspaceId), { method: "GET" });
  } catch (error) {
    logEvent({
      event: "workspace_agent_diagnostic_runtime_unreachable",
      level: "warn",
      workspace_id: workspaceId,
      error_message: errorMessage(error),
    });
    return unreachable(errorMessage(error));
  }

  if (response.status < 200 || response.status >= 300) {
    logEvent({
      event: "workspace_agent_diagnostic_runtime_unhealthy",
      level: "warn",
      workspace_id: workspaceId,
      upstream_status: response.status,
      upstream_body: response.body,
    });
    return unreachable(`Runtime diagnostic endpoint returned ${response.status}`);
  }

  const runtimeDiagnostic = WorkspaceAgentDiagnosticRuntimeResponseSchema.parse(response.body);
  return WorkspaceAgentDiagnosticResponseSchema.parse({
    ok: true,
    workspaceId: runtimeDiagnostic.workspace_id,
    agents: runtimeDiagnostic.agents.map((agent) => ({
      agentId: agent.agent_id,
      runnerKind: agent.runner_kind,
      status: agent.status === "ready" ? "ok" : agent.status === "not_ready" ? "error" : "pending",
      errorCode: agent.reason,
      errorDetails: agent.details,
    })),
  });
}
