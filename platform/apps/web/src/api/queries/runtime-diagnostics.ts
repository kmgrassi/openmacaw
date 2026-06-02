import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAgentDiagnostic,
  type AgentDiagnosticResponse,
} from "../agent-diagnostic";
import {
  listOrchestratorSessions,
  type OrchestratorSessionsResult,
} from "../orchestrator-sessions";
import { queryKeys } from "../query-keys";
import { invalidateRuntimeDiagnostics } from "../query-invalidation";
import { fetchAgentHealth } from "../setup";
import { getWorkspaceAgentDiagnostics } from "../workspace-agent-diagnostics";
import {
  getWorkerBridgeSession,
  listWorkerBridgeSessions,
  stopWorkerBridgeSession,
  type WorkerBridgeSession,
} from "../worker-bridge";
import type { AgentHealthResponse } from "../../../../../contracts/agent-health";
import type { WorkspaceAgentDiagnosticResponse } from "../../../../../contracts/agent-health";

type GatewayRequest = <T = unknown>(
  method: string,
  params?: unknown,
) => Promise<T>;

async function loadWorkerSessionDetails(): Promise<WorkerBridgeSession[]> {
  const sessions = await listWorkerBridgeSessions();
  return Promise.all(
    sessions.map(async (session) => {
      try {
        return await getWorkerBridgeSession(session.id);
      } catch {
        return session;
      }
    }),
  );
}

export function runtimeScopeKey(
  scope:
    | {
        agentId?: string | null;
        workspaceId?: string | null;
        sessionKey?: string | null;
      }
    | null
    | undefined,
) {
  if (!scope) return "none";
  return [
    scope.workspaceId ?? "workspace:none",
    scope.agentId ?? "agent:none",
    scope.sessionKey ?? "session:none",
  ].join(":");
}

export function useOrchestratorSessionSummaryQuery({
  connected,
  debugMode,
  request,
  scopeKey,
  limit = 5,
}: {
  connected: boolean;
  debugMode: boolean;
  request: GatewayRequest;
  scopeKey: string;
  limit?: number;
}) {
  return useQuery<OrchestratorSessionsResult>({
    queryKey: queryKeys.sessions.orchestrator(scopeKey),
    queryFn: () => listOrchestratorSessions(request, limit),
    enabled: debugMode && connected,
    staleTime: 5_000,
  });
}

export function useWorkerBridgeSessionsQuery() {
  return useQuery<WorkerBridgeSession[]>({
    queryKey: queryKeys.sessions.worker(),
    queryFn: loadWorkerSessionDetails,
    staleTime: 5_000,
  });
}

export function useAgentDiagnosticQuery({
  agentId,
  workspaceId,
  enabled = true,
}: {
  agentId?: string | null;
  workspaceId?: string | null;
  enabled?: boolean;
}) {
  return useQuery<AgentDiagnosticResponse>({
    queryKey: queryKeys.agentDiagnostics.detail(agentId ?? "none", workspaceId),
    queryFn: () => getAgentDiagnostic(agentId!, workspaceId),
    enabled: enabled && Boolean(agentId),
    staleTime: 10_000,
  });
}

export function useAgentHealthQuery({
  agentId,
  enabled = true,
}: {
  agentId?: string | null;
  enabled?: boolean;
}) {
  return useQuery<AgentHealthResponse>({
    queryKey: queryKeys.agentHealth.detail(agentId ?? "none"),
    queryFn: () => fetchAgentHealth(agentId!),
    enabled: enabled && Boolean(agentId),
    staleTime: 10_000,
  });
}

export function useWorkspaceAgentDiagnosticsQuery({
  workspaceId,
  enabled = true,
}: {
  workspaceId?: string | null;
  enabled?: boolean;
}) {
  return useQuery<WorkspaceAgentDiagnosticResponse>({
    queryKey: queryKeys.workspaceAgentDiagnostics.detail(workspaceId ?? "none"),
    queryFn: () => getWorkspaceAgentDiagnostics(workspaceId!),
    enabled: enabled && Boolean(workspaceId),
    staleTime: 10_000,
  });
}

export function useStopWorkerBridgeSessionMutation({
  agentId,
  workspaceId,
  orchestratorScopeKey,
}: {
  agentId?: string | null;
  workspaceId?: string | null;
  orchestratorScopeKey?: string | null;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => stopWorkerBridgeSession(id),
    onSuccess: () => {
      invalidateRuntimeDiagnostics(queryClient, {
        agentId,
        workspaceId,
        orchestratorScopeKey,
      });
    },
  });
}
