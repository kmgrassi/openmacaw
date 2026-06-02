import type { Dispatch, SetStateAction } from "react";

import type { BrokerRunRow, BrokerTaskRow } from "../../api/agent-dashboard";
import type { TaskUsageSummary } from "../../hooks/useAgentDashboard";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { LoadingState } from "../ui/LoadingState";
import { ToolEventRow } from "./ToolEventRow";
import {
  formatNumber,
  formatStatusLabel,
  formatTimestamp,
  formatToolEventSummary,
  statusVariant,
} from "./utils";

type Props = {
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  history: BrokerRunRow[];
  taskRowsByRunId: Record<string, BrokerTaskRow[]>;
  taskSummaryByRunId: Record<string, TaskUsageSummary>;
  totalRuns: number;
  totalPages: number;
  canGoPrev: boolean;
  canGoNext: boolean;
  loading: boolean;
};

export function RunHistoryCard({
  page,
  setPage,
  history,
  taskRowsByRunId,
  taskSummaryByRunId,
  totalRuns,
  totalPages,
  canGoPrev,
  canGoNext,
  loading,
}: Props) {
  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Run history
          </div>
          <div className="mt-1 text-sm text-slate-300">
            {totalRuns} recorded runs
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!canGoPrev}
            onClick={() => setPage(page - 1)}
          >
            Prev
          </Button>
          <span className="text-xs text-slate-500">
            Page {page + 1} / {totalPages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canGoNext}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {history.length === 0 && (
          <EmptyState
            label={
              loading ? (
                <LoadingState label="Loading run history..." />
              ) : (
                "No broker runs recorded for this agent yet."
              )
            }
            density="compact"
            align="left"
          />
        )}

        {history.map((run) => {
          const summary = taskSummaryByRunId[run.runId];
          const tasks = taskRowsByRunId[run.runId] ?? [];
          const toolEventCount = tasks.reduce(
            (count, task) => count + (task.toolEvents?.length ?? 0),
            0,
          );
          const visibleToolEvents = tasks
            .flatMap((task) => task.toolEvents ?? [])
            .slice(-4);
          const trackerLabel =
            run.trackerIssueKey || run.issueIdentifier || "Manual";
          return (
            <div
              key={run.runId}
              className="rounded-md border border-border bg-surface px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-300">
                      {run.runId.slice(0, 8)}
                    </span>
                    <Badge variant={statusVariant(run.status)}>
                      {formatStatusLabel(run.status)}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-500">
                    {trackerLabel} • Attempt {run.attempt}
                  </div>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <div>{formatTimestamp(run.createdAt)}</div>
                  <div>{formatNumber(summary?.totalTokens)} tokens</div>
                </div>
              </div>
              {(tasks.length > 0 || toolEventCount > 0) && (
                <div className="mt-2 space-y-1 border-t border-border pt-2">
                  {tasks.slice(0, 3).map((task) => (
                    <div
                      key={task.taskId}
                      className="flex items-start justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 truncate text-slate-400">
                        {formatToolEventSummary(task)}
                      </div>
                      <Badge
                        variant={statusVariant(
                          task.toolEvents?.[task.toolEvents.length - 1]
                            ?.status ?? task.status,
                        )}
                      >
                        {formatStatusLabel(
                          task.toolEvents?.[task.toolEvents.length - 1]
                            ?.status ?? task.status,
                        )}
                      </Badge>
                    </div>
                  ))}
                  {toolEventCount > 3 && (
                    <div className="text-xs text-slate-500">
                      {toolEventCount - 3} more tool events
                    </div>
                  )}
                  {visibleToolEvents.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {visibleToolEvents.map((event) => (
                        <ToolEventRow key={event.id} event={event} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
