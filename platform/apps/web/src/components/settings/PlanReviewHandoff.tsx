import { useEffect, useMemo, useState } from "react";
import { fetchPlanReviews, type PlanReviewPlan } from "../../api/plan-review";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

export type SelectedCodingHandoff = {
  planId: string;
  taskIds: string[];
};

type Props = {
  workspaceId: string | null | undefined;
  value: SelectedCodingHandoff | null;
  onChange: (value: SelectedCodingHandoff | null) => void;
};

function formatTimestamp(value: string | null) {
  if (!value) return "unknown";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toggleTask(
  plan: PlanReviewPlan,
  current: SelectedCodingHandoff | null,
  taskId: string,
): SelectedCodingHandoff {
  const currentIds = current?.planId === plan.id ? current.taskIds : [];
  const nextIds = currentIds.includes(taskId)
    ? currentIds.filter((id) => id !== taskId)
    : [...currentIds, taskId];

  return {
    planId: plan.id,
    taskIds: nextIds.length > 0 ? nextIds : plan.tasks.map((task) => task.id),
  };
}

export function PlanReviewHandoff({ workspaceId, value, onChange }: Props) {
  const [plans, setPlans] = useState<PlanReviewPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setPlans([]);
      onChange(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void fetchPlanReviews(workspaceId)
      .then((rows) => {
        if (cancelled) return;
        setPlans(rows);
        const selectedStillExists = rows.some(
          (plan) =>
            plan.id === value?.planId &&
            value.taskIds.every((taskId) =>
              plan.tasks.some((task) => task.id === taskId),
            ),
        );
        if (!selectedStillExists) onChange(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.id === value?.planId) ?? null,
    [plans, value?.planId],
  );

  if (!workspaceId) {
    return (
      <div className="rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
        Workspace context is required before a reviewed plan can be handed to
        coding.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-slate-200">
            Plan review handoff
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Select the reviewed planner output before starting a coding worker.
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void fetchPlanReviews(workspaceId).then(setPlans)}
        >
          Refresh
        </Button>
      </div>

      {loading && (
        <p className="text-xs text-slate-500">Loading planner output...</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!loading && plans.length === 0 && (
        <p className="text-xs text-slate-500">
          No planner-created tasks with plan IDs were found for this workspace.
        </p>
      )}

      <div className="space-y-2">
        {plans.map((plan) => {
          const selected = value?.planId === plan.id;
          const selectedTaskIds = selected ? value.taskIds : [];
          return (
            <div
              key={plan.id}
              className="rounded-md border border-border bg-surface-raised px-3 py-3"
            >
              <button
                type="button"
                className="flex w-full items-start justify-between gap-3 text-left"
                onClick={() =>
                  onChange({
                    planId: plan.id,
                    taskIds: plan.tasks.map((task) => task.id),
                  })
                }
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-200">
                      {plan.name ?? plan.id}
                    </span>
                    <Badge variant={selected ? "success" : "default"}>
                      {plan.status}
                    </Badge>
                  </div>
                  {plan.description && (
                    <p className="mt-1 max-h-10 overflow-hidden text-xs text-slate-500">
                      {plan.description}
                    </p>
                  )}
                  <div className="mt-1 text-xs text-slate-500">
                    {plan.tasks.length} tasks - updated{" "}
                    {formatTimestamp(plan.updatedAt)}
                  </div>
                </div>
                <span className="text-xs text-slate-500">
                  {selected ? "Selected" : "Select"}
                </span>
              </button>

              {selected && (
                <div className="mt-3 space-y-3 border-t border-border pt-3">
                  <div className="space-y-2">
                    {plan.tasks.map((task) => (
                      <label
                        key={task.id}
                        className="flex items-start gap-2 rounded-md bg-slate-950/30 px-2 py-2"
                      >
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 rounded border-border bg-slate-950"
                          checked={selectedTaskIds.includes(task.id)}
                          onChange={() =>
                            onChange(toggleTask(plan, value, task.id))
                          }
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-slate-300">
                            {task.name ?? task.id}
                          </span>
                          {task.description && (
                            <span className="mt-0.5 block text-xs text-slate-500">
                              {task.description}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>

                  {selectedPlan?.evidence.length ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-400">
                        Planner evidence
                      </div>
                      {selectedPlan.evidence.slice(0, 4).map((item, index) => (
                        <div
                          key={`${item.path}:${item.line ?? ""}:${index}`}
                          className="rounded bg-slate-950/40 px-2 py-1.5"
                        >
                          <div className="font-mono text-xs text-slate-300">
                            {item.path}
                            {item.line ? `:${item.line}` : ""}
                          </div>
                          {item.snippet && (
                            <div className="mt-1 max-h-10 overflow-hidden text-xs text-slate-500">
                              {item.snippet}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
