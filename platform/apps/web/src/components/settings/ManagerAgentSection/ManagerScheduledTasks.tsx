import { useMemo, useState } from "react";

import type {
  ScheduledTaskProjection,
  ScheduledTaskSchedule,
} from "../../../../../../contracts/scheduled-tasks";
import {
  useCancelScheduledTaskMutation,
  useRunScheduledTaskNowMutation,
  useScheduledTasksQuery,
} from "../../../api/query-hooks";
import { Alert } from "../../ui/Alert";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

type ManagerScheduledTasksProps = {
  workspaceId: string | null | undefined;
  agentId: string | null;
};

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "None";
}

type ScheduledTask = ScheduledTaskProjection;

function scheduleLabel(schedule: ScheduledTaskSchedule) {
  if (schedule.kind === "at") return "One time";
  if (schedule.kind === "cron") return `Cron: ${schedule.expression}`;
  const unit = schedule.interval === 1 ? schedule.unit : `${schedule.unit}s`;
  const at = schedule.at ? ` at ${schedule.at}` : "";
  return `Every ${schedule.interval} ${unit}${at}`;
}

function taskStatus(task: ScheduledTask) {
  if (task.enabled) return { label: "Enabled", variant: "success" as const };
  return { label: "Disabled", variant: "default" as const };
}

export function ManagerScheduledTasks({
  workspaceId,
  agentId,
}: ManagerScheduledTasksProps) {
  const [error, setError] = useState<string | null>(null);
  const [mutatingTaskId, setMutatingTaskId] = useState<string | null>(null);
  const tasksQuery = useScheduledTasksQuery(workspaceId, agentId);
  const cancelTaskMutation = useCancelScheduledTaskMutation(
    workspaceId,
    agentId,
  );
  const runTaskMutation = useRunScheduledTaskNowMutation(workspaceId, agentId);
  const tasks = tasksQuery.data ?? [];
  const loading = tasksQuery.isLoading || tasksQuery.isFetching;

  const canLoad = Boolean(workspaceId && agentId);
  const queryError = tasksQuery.error;

  const enabledCount = useMemo(
    () => tasks.filter((task) => task.enabled).length,
    [tasks],
  );

  async function handleCancel(task: ScheduledTask) {
    if (!workspaceId || !agentId) return;
    setMutatingTaskId(task.id);
    setError(null);
    try {
      await cancelTaskMutation.mutateAsync(task.id);
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : "Could not cancel scheduled task",
      );
    } finally {
      setMutatingTaskId(null);
    }
  }

  async function handleRunNow(task: ScheduledTask) {
    if (!workspaceId || !agentId) return;
    setMutatingTaskId(task.id);
    setError(null);
    try {
      await runTaskMutation.mutateAsync(task.id);
    } catch (runError) {
      setError(
        runError instanceof Error
          ? runError.message
          : "Could not run scheduled task",
      );
    } finally {
      setMutatingTaskId(null);
    }
  }

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-medium text-slate-300">
            Scheduled Tasks
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Audit recurring instructions created for the workspace manager.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={enabledCount > 0 ? "success" : "default"}>
            {enabledCount} active
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            disabled={!canLoad || loading}
            loading={loading}
            onClick={() => {
              setError(null);
              void tasksQuery.refetch();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      {!agentId && (
        <Alert tone="warning" compact>
          Activate the manager agent before scheduled tasks can be audited.
        </Alert>
      )}

      {(error || queryError) && (
        <Alert tone="error" compact className="mb-3">
          {error ?? (queryError as Error).message}
        </Alert>
      )}

      {canLoad && !loading && tasks.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-slate-500">
          No scheduled tasks have been created for this manager agent.
        </div>
      ) : null}

      {tasks.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="hidden grid-cols-[minmax(12rem,1.4fr)_minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_minmax(7rem,auto)] gap-3 border-b border-border bg-surface-overlay px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500 lg:grid">
            <span>Task</span>
            <span>Cadence</span>
            <span>Next run</span>
            <span>Last run</span>
            <span className="text-right">Actions</span>
          </div>
          <div className="divide-y divide-border">
            {tasks.map((task) => {
              const status = taskStatus(task);
              const busy = mutatingTaskId === task.id;
              return (
                <div
                  key={task.id}
                  className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(12rem,1.4fr)_minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_minmax(7rem,auto)] lg:items-start"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-200">
                        {task.title}
                      </span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                      {task.instructions || "No instructions stored."}
                    </p>
                    {task.lastError && (
                      <p className="mt-2 text-xs text-red-300">
                        {task.lastError}
                      </p>
                    )}
                  </div>

                  <div>
                    <div className="text-xs font-medium text-slate-500 lg:hidden">
                      Cadence
                    </div>
                    <div className="text-sm text-slate-300">
                      {scheduleLabel(task.schedule)}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-slate-500 lg:hidden">
                      Next run
                    </div>
                    <div className="text-sm text-slate-300">
                      {formatDateTime(task.nextRunAt)}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-slate-500 lg:hidden">
                      Last run
                    </div>
                    <div className="text-sm text-slate-300">
                      {formatDateTime(task.lastRunAt)}
                    </div>
                  </div>

                  <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy}
                      disabled={busy || !task.enabled}
                      onClick={() => void handleRunNow(task)}
                    >
                      Run now
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy}
                      disabled={busy || !task.enabled}
                      onClick={() => void handleCancel(task)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
