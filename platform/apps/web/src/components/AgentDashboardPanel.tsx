import { useAgentDashboard } from "../hooks/useAgentDashboard";
import { Alert } from "./ui/Alert";
import { Badge } from "./ui/Badge";
import { LatestRunCard } from "./AgentDashboardPanel/LatestRunCard";
import { RunHistoryCard } from "./AgentDashboardPanel/RunHistoryCard";
import {
  configStatusLabel,
  runApprovalMessage,
  statusVariant,
} from "./AgentDashboardPanel/utils";

type Props = {
  agentId: string;
  workspaceId?: string | null;
};

export function AgentDashboardPanel({ agentId, workspaceId }: Props) {
  const {
    page,
    setPage,
    latestRun,
    latestRunSummary,
    history,
    taskRowsByRunId,
    taskSummaryByRunId,
    configState,
    totalRuns,
    totalPages,
    canGoPrev,
    canGoNext,
    loading,
    error,
    realtimeError,
    reload,
  } = useAgentDashboard(agentId, workspaceId);
  const approvalMessage = runApprovalMessage({
    error: latestRun?.error,
    terminalReason: latestRun?.terminalReason,
    lastEvent: latestRunSummary?.lastEvent,
    configApplyError: configState?.lastApplyError,
  });

  return (
    <div className="border-b border-border bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-200">
              Agent runtime
            </div>
            <div className="text-xs text-slate-500">
              Live run/task updates with durable `broker_run` history.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(configState?.lastApplyStatus)}>
              {configStatusLabel(configState?.lastApplyStatus)}
            </Badge>
            <button
              onClick={() => void reload()}
              className="text-xs text-slate-500 hover:text-slate-300"
              title="Refresh dashboard"
            >
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <Alert tone="error" compact>
            {error}
          </Alert>
        )}

        {realtimeError && (
          <Alert tone="warning" compact detail={realtimeError}>
            Live dashboard subscriptions are unavailable. Static refresh still
            works.
          </Alert>
        )}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <LatestRunCard
            latestRun={latestRun}
            latestRunSummary={latestRunSummary}
            configState={configState}
            approvalMessage={approvalMessage}
          />

          <RunHistoryCard
            page={page}
            setPage={setPage}
            history={history}
            taskRowsByRunId={taskRowsByRunId}
            taskSummaryByRunId={taskSummaryByRunId}
            totalRuns={totalRuns}
            totalPages={totalPages}
            canGoPrev={canGoPrev}
            canGoNext={canGoNext}
            loading={loading}
          />
        </div>
      </div>
    </div>
  );
}
