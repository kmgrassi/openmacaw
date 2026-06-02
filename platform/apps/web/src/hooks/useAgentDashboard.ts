import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchAgentDashboardVersion,
  fetchBrokerRunHistory,
  fetchBrokerTasks,
  fetchGatewayConfigState,
  fetchLatestBrokerRun,
  RUN_HISTORY_PAGE_SIZE,
  type BrokerTaskRow,
} from "../api/agent-dashboard";
import { invalidateAgentDashboardQueries } from "../api/query-invalidation";
import { queryKeys } from "../api/query-keys";

export type TaskUsageSummary = {
  taskCount: number;
  retryCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastEvent: string | null;
  lastEventAt: string | null;
};

function summarizeTasks(tasks: BrokerTaskRow[]): TaskUsageSummary {
  return tasks.reduce<TaskUsageSummary>(
    (summary, task) => {
      const nextEventAt = task.lastEventAt ?? null;
      const previousEventAt = summary.lastEventAt;
      const shouldReplaceLastEvent = nextEventAt
        ? !previousEventAt ||
          new Date(nextEventAt).getTime() >= new Date(previousEventAt).getTime()
        : false;

      return {
        taskCount: summary.taskCount + 1,
        retryCount: Math.max(
          summary.retryCount,
          Math.max((task.attempt ?? 1) - 1, 0),
        ),
        inputTokens: summary.inputTokens + (task.inputTokens ?? 0),
        outputTokens: summary.outputTokens + (task.outputTokens ?? 0),
        totalTokens: summary.totalTokens + (task.totalTokens ?? 0),
        lastEvent: shouldReplaceLastEvent
          ? (task.lastEvent ?? null)
          : summary.lastEvent,
        lastEventAt: shouldReplaceLastEvent ? nextEventAt : summary.lastEventAt,
      };
    },
    {
      taskCount: 0,
      retryCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastEvent: null,
      lastEventAt: null,
    },
  );
}

function buildTaskMaps(tasks: BrokerTaskRow[]) {
  const grouped = tasks.reduce<Record<string, BrokerTaskRow[]>>((acc, task) => {
    const runTasks = acc[task.runId] ?? [];
    runTasks.push(task);
    acc[task.runId] = runTasks;
    return acc;
  }, {});

  const summaryByRunId = Object.fromEntries(
    Object.entries(grouped).map(([runId, runTasks]) => [
      runId,
      summarizeTasks(runTasks),
    ]),
  ) as Record<string, TaskUsageSummary>;

  return {
    taskRowsByRunId: grouped,
    taskSummaryByRunId: summaryByRunId,
  };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useAgentDashboard(
  agentId: string,
  workspaceId?: string | null,
) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const dashboardVersionRef = useRef<string | null>(null);
  const pendingDashboardVersionRef = useRef<string | null>(null);

  useEffect(() => {
    setPage(0);
    dashboardVersionRef.current = null;
    pendingDashboardVersionRef.current = null;
  }, [agentId]);

  const latestRunQuery = useQuery({
    queryKey: queryKeys.agentDashboard.latestRun(agentId),
    queryFn: () => fetchLatestBrokerRun(agentId),
    enabled: Boolean(agentId),
    staleTime: 2_000,
  });

  const historyQuery = useQuery({
    queryKey: queryKeys.agentDashboard.runHistory(agentId, page),
    queryFn: () => fetchBrokerRunHistory(agentId, page),
    enabled: Boolean(agentId),
    staleTime: 2_000,
  });

  const configStateQuery = useQuery({
    queryKey: queryKeys.agentDashboard.configState(agentId, workspaceId),
    queryFn: () => fetchGatewayConfigState(agentId, workspaceId),
    enabled: Boolean(agentId),
    staleTime: 5_000,
  });

  const runIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...(historyQuery.data?.runs.map((run) => run.runId) ?? []),
          ...(latestRunQuery.data ? [latestRunQuery.data.runId] : []),
        ]),
      ),
    [historyQuery.data?.runs, latestRunQuery.data],
  );

  const tasksQuery = useQuery({
    queryKey: queryKeys.agentDashboard.tasks(agentId, runIds),
    queryFn: () => fetchBrokerTasks(agentId, runIds),
    enabled: Boolean(agentId) && runIds.length > 0,
    staleTime: 2_000,
  });

  const dashboardVersionQuery = useQuery({
    queryKey: queryKeys.agentDashboard.version(agentId, workspaceId),
    queryFn: () => fetchAgentDashboardVersion(agentId, workspaceId),
    enabled: Boolean(agentId),
    refetchInterval: (query) => query.state.data?.pollAfterMs ?? 10_000,
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    const version = dashboardVersionQuery.data?.version;
    if (!version) return;

    if (dashboardVersionRef.current === null) {
      dashboardVersionRef.current = version;
      return;
    }

    if (dashboardVersionRef.current !== version) {
      if (pendingDashboardVersionRef.current === version) return;
      pendingDashboardVersionRef.current = version;

      void invalidateAgentDashboardQueries(queryClient, agentId, workspaceId)
        .then(() => {
          dashboardVersionRef.current = version;
          pendingDashboardVersionRef.current = null;
        })
        .catch(() => {
          pendingDashboardVersionRef.current = null;
        });
    }
  }, [
    agentId,
    dashboardVersionQuery.data?.version,
    dashboardVersionQuery.dataUpdatedAt,
    queryClient,
    workspaceId,
  ]);

  const taskMaps = useMemo(
    () => buildTaskMaps(tasksQuery.data ?? []),
    [tasksQuery.data],
  );

  const totalRuns = historyQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRuns / RUN_HISTORY_PAGE_SIZE));
  const canGoPrev = page > 0;
  const canGoNext = page + 1 < totalPages;

  const reload = useCallback(async () => {
    await invalidateAgentDashboardQueries(queryClient, agentId, workspaceId);
  }, [agentId, queryClient, workspaceId]);

  const loadError =
    latestRunQuery.error ??
    historyQuery.error ??
    tasksQuery.error ??
    configStateQuery.error;

  return {
    page,
    setPage,
    latestRun: latestRunQuery.data ?? null,
    latestRunSummary: latestRunQuery.data
      ? (taskMaps.taskSummaryByRunId[latestRunQuery.data.runId] ?? null)
      : null,
    history: historyQuery.data?.runs ?? [],
    taskRowsByRunId: taskMaps.taskRowsByRunId,
    taskSummaryByRunId: taskMaps.taskSummaryByRunId,
    configState: configStateQuery.data ?? null,
    totalRuns,
    totalPages,
    canGoPrev,
    canGoNext,
    loading:
      latestRunQuery.isLoading ||
      historyQuery.isLoading ||
      tasksQuery.isLoading ||
      configStateQuery.isLoading,
    error: loadError
      ? errorMessage(loadError, "Could not load agent dashboard")
      : null,
    realtimeError: dashboardVersionQuery.error
      ? errorMessage(
          dashboardVersionQuery.error,
          "Dashboard updates are unavailable",
        )
      : null,
    reload,
  };
}
