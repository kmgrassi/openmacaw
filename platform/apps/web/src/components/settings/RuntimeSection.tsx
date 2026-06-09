import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  runtimeScopeKey,
  useAgentDiagnosticQuery,
  useAgentHealthQuery,
  useOrchestratorSessionSummaryQuery,
  useStopWorkerBridgeSessionMutation,
  useWorkerBridgeSessionsQuery,
} from "../../api/queries/runtime-diagnostics";
import { invalidateRuntimeDiagnostics } from "../../api/query-invalidation";
import { useGatewayContext } from "../../context/GatewayContext";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { PageHeader } from "../ui/PageHeader";
import { DiagnosticsExportButton } from "../DiagnosticsExportButton";
import { useUiStore } from "../../stores/ui";
import { AgentHealthCard } from "./RuntimeSection/AgentHealthCard";
import { CapabilitiesCard } from "./RuntimeSection/CapabilitiesCard";
import { ClaudeCodeDiagnosticsCard } from "./RuntimeSection/ClaudeCodeDiagnosticsCard";
import { CodexOAuthDiagnosticsCard } from "./RuntimeSection/CodexOAuthDiagnosticsCard";
import { ConnectionCard } from "./RuntimeSection/ConnectionCard";
import { ContainerArtifactHandoffCard } from "./RuntimeSection/ContainerArtifactHandoffCard";
import { DebugSnapshotCard } from "./RuntimeSection/DebugSnapshotCard";
import { OrchestratorSessionsCard } from "./RuntimeSection/OrchestratorSessionsCard";
import { ResolvedScopeCard } from "./RuntimeSection/ResolvedScopeCard";
import { WorkerSessionTable } from "./RuntimeSection/WorkerSessionTable";

export function RuntimeSection() {
  const {
    connected,
    status,
    hello,
    gatewayReady,
    scope,
    request,
    connect,
    disconnect,
  } = useGatewayContext();
  const queryClient = useQueryClient();
  const debugMode = useUiStore((state) => state.debugMode);
  const toggleDebugMode = useUiStore((state) => state.toggleDebugMode);
  const scopeKey = useMemo(() => runtimeScopeKey(scope), [scope]);
  const orchestratorSessionsQuery = useOrchestratorSessionSummaryQuery({
    connected,
    debugMode,
    request,
    scopeKey,
    limit: 5,
  });
  const workerSessionsQuery = useWorkerBridgeSessionsQuery();
  const agentDiagnosticQuery = useAgentDiagnosticQuery({
    agentId: scope?.agentId,
    workspaceId: scope?.workspaceId,
  });
  const agentHealthQuery = useAgentHealthQuery({ agentId: scope?.agentId });
  const stopWorkerSession = useStopWorkerBridgeSessionMutation({
    agentId: scope?.agentId,
    workspaceId: scope?.workspaceId,
    orchestratorScopeKey: scopeKey,
  });
  const wasConnectedRef = useRef(connected);

  useEffect(() => {
    if (!wasConnectedRef.current && connected) {
      invalidateRuntimeDiagnostics(queryClient, {
        agentId: scope?.agentId,
        workspaceId: scope?.workspaceId,
        orchestratorScopeKey: scopeKey,
      });
    }
    wasConnectedRef.current = connected;
  }, [connected, queryClient, scope?.agentId, scope?.workspaceId, scopeKey]);

  const orchestratorSummary =
    debugMode && connected ? (orchestratorSessionsQuery.data ?? null) : null;
  const sessionCount = orchestratorSummary?.count ?? null;
  const recentSessions = orchestratorSummary?.sessions.slice(0, 5) ?? [];
  const hasSessions = orchestratorSummary
    ? orchestratorSummary.count > 0 || orchestratorSummary.sessions.length > 0
    : null;
  const orchestratorSessionsError =
    debugMode && connected
      ? (orchestratorSessionsQuery.error as Error | null)
      : null;
  const workerSessions = workerSessionsQuery.data ?? [];
  const workerSessionsLoading = workerSessionsQuery.isFetching;
  const workerSessionsError =
    (workerSessionsQuery.error as Error | null)?.message ??
    (stopWorkerSession.error as Error | null)?.message ??
    null;
  const agentDiagnostic = agentDiagnosticQuery.data ?? null;
  const agentDiagnosticLoading = agentDiagnosticQuery.isFetching;
  const agentDiagnosticError =
    (agentDiagnosticQuery.error as Error | null)?.message ?? null;
  const agentHealth = agentHealthQuery.data ?? null;
  const agentHealthError =
    (agentHealthQuery.error as Error | null)?.message ?? null;

  function refreshRuntimeDiagnostics() {
    invalidateRuntimeDiagnostics(queryClient, {
      agentId: scope?.agentId,
      workspaceId: scope?.workspaceId,
      orchestratorScopeKey: scopeKey,
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Runtime"
        description="Connection state, resolved scope, and gateway diagnostics."
        actions={
          <>
            <DiagnosticsExportButton
              agentHealth={agentHealth}
              agentDiagnostic={agentDiagnostic}
            />
            <Button
              size="sm"
              variant={debugMode ? "secondary" : "ghost"}
              onClick={toggleDebugMode}
              aria-pressed={debugMode}
            >
              Debug {debugMode ? "On" : "Off"}
            </Button>
          </>
        }
      />

      <ConnectionCard
        gatewayReady={gatewayReady}
        hello={hello}
        status={status}
        onConnect={() => void connect()}
        onDisconnect={disconnect}
      />

      <ResolvedScopeCard scope={scope} status={status} />

      {debugMode && (
        <OrchestratorSessionsCard
          error={orchestratorSessionsError}
          hasSessions={hasSessions}
          recentSessions={recentSessions}
          sessionCount={sessionCount}
        />
      )}

      {debugMode && hello?.features && (
        <CapabilitiesCard
          methods={hello.features.methods}
          events={hello.features.events}
        />
      )}

      {debugMode && (
        <DebugSnapshotCard
          value={{ connected, status, gatewayReady, scope, hello }}
        />
      )}

      <ClaudeCodeDiagnosticsCard
        diagnostic={agentDiagnostic?.claudeCode}
        error={agentDiagnosticError}
        loading={agentDiagnosticLoading}
        onRefresh={refreshRuntimeDiagnostics}
      />

      <CodexOAuthDiagnosticsCard
        diagnostic={agentDiagnostic?.codexOAuth}
        error={agentDiagnosticError}
        loading={agentDiagnosticLoading}
        onRefresh={refreshRuntimeDiagnostics}
      />

      <ContainerArtifactHandoffCard />

      {agentHealth && (
        <AgentHealthCard agentHealth={agentHealth} error={agentHealthError} />
      )}

      <WorkerSessionTable
        error={workerSessionsError}
        loading={workerSessionsLoading}
        onRefresh={refreshRuntimeDiagnostics}
        onStop={(sessionId) => stopWorkerSession.mutate(sessionId)}
        sessions={workerSessions}
        stoppingSessionId={
          stopWorkerSession.isPending
            ? (stopWorkerSession.variables ?? null)
            : null
        }
      />

      {!connected && status !== "scope_missing" && (
        <Card>
          <p className="text-sm text-slate-400">Not connected to gateway.</p>
        </Card>
      )}
    </div>
  );
}
