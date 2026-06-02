import type { PlanRecord, WorkItemProjection } from "../../api/plans";
import { Button } from "../../components/ui/Button";
import { SnoozeButton } from "../../components/work-items/SnoozeButton";
import { SnoozedBadge } from "../../components/work-items/SnoozedBadge";
import { DetailChip, EmptyState, formatDate, StatusBadge } from "./utils";

type Props = {
  workspaceId: string;
  plan: PlanRecord;
  workItems: WorkItemProjection[];
  deletingId: string | null;
  onClose: () => void;
  onDeleteWorkItem: (workItem: WorkItemProjection) => void;
  onWorkItemUpdated: (workItem: WorkItemProjection) => void;
  onError: (message: string | null) => void;
};

export function PlanDetailsPanel({
  workspaceId,
  plan,
  workItems,
  deletingId,
  onClose,
  onDeleteWorkItem,
  onWorkItemUpdated,
  onError,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close plan details"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-border bg-slate-950 shadow-2xl">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-slate-100">
                {plan.name || "Untitled plan"}
              </h2>
              <div className="mt-1 text-xs text-slate-500">{plan.id}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-2 py-1 text-sm text-slate-400 transition-colors hover:text-slate-100"
            >
              Close
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusBadge value={plan.status} />
            <span className="text-xs text-slate-500">
              {workItems.length} work items
            </span>
            <span className="text-xs text-slate-500">
              Updated {formatDate(plan.updatedAt)}
            </span>
          </div>
          {(plan.description || plan.intent) && (
            <p className="mt-3 text-sm leading-6 text-slate-300">
              {plan.description || plan.intent}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {workItems.length === 0 ? (
            <EmptyState label="No work items are associated with this plan." />
          ) : (
            <div className="space-y-3">
              {workItems.map((workItem) => (
                <div
                  key={workItem.id}
                  className="rounded-md border border-border bg-surface/60 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-100">
                        {workItem.title || "Untitled work item"}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {workItem.identifier || workItem.id}
                      </div>
                    </div>
                    <StatusBadge value={workItem.state} />
                  </div>
                  {(workItem.description || workItem.instructions) && (
                    <p className="mt-3 line-clamp-4 text-sm leading-6 text-slate-300">
                      {workItem.description || workItem.instructions}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>{workItem.source || "unknown source"}</span>
                    <DetailChip value={workItem.runnerKind} />
                    <DetailChip value={workItem.repository} />
                    {workItem.priority && <span>{workItem.priority}</span>}
                    <span>Updated {formatDate(workItem.updatedAt)}</span>
                  </div>
                  {workItem.labels && workItem.labels.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {workItem.labels.map((label) => (
                        <span
                          key={label}
                          className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-300"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                  {workItem.snooze && (
                    <div className="mt-3">
                      <SnoozedBadge
                        workspaceId={workspaceId}
                        workItem={workItem}
                        onWoken={onWorkItemUpdated}
                        onError={onError}
                        className="w-full"
                      />
                    </div>
                  )}
                  <div className="mt-3 flex justify-end gap-2">
                    {!workItem.snooze && (
                      <SnoozeButton
                        workspaceId={workspaceId}
                        workItemId={workItem.id}
                        onSnoozed={onWorkItemUpdated}
                        onError={onError}
                      />
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      loading={deletingId === workItem.id}
                      onClick={() => onDeleteWorkItem(workItem)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
