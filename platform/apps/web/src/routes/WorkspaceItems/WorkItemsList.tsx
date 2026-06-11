import type { PlanRecord, WorkItemProjection } from "../../api/plans";
import type { ProviderCutover } from "../../api/provider-cutovers";
import { Button } from "../../components/ui/Button";
import { WorkItemFallbackBadge } from "../../components/work-items/WorkItemFallbackBadge";
import { SnoozeButton } from "../../components/work-items/SnoozeButton";
import { SnoozedBadge } from "../../components/work-items/SnoozedBadge";
import { DetailChip, EmptyState, formatDate, StatusBadge } from "./utils";

type Props = {
  workspaceId: string;
  plans: PlanRecord[];
  workItems: WorkItemProjection[];
  cutoversByWorkItemId: ReadonlyMap<string, readonly ProviderCutover[]>;
  loading: boolean;
  deletingId: string | null;
  onDeleteWorkItem: (workItem: WorkItemProjection) => void;
  onWorkItemUpdated: (workItem: WorkItemProjection) => void;
  onError: (message: string | null) => void;
};

export function WorkItemsList({
  workspaceId,
  plans,
  workItems,
  cutoversByWorkItemId,
  loading,
  deletingId,
  onDeleteWorkItem,
  onWorkItemUpdated,
  onError,
}: Props) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {workItems.length === 0 && !loading ? (
        <EmptyState label="No work items found for this workspace." />
      ) : (
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Work item</th>
              <th className="px-4 py-3 font-medium">State</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Runner</th>
              <th className="px-4 py-3 font-medium">Repository</th>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Updated</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-slate-950">
            {workItems.map((workItem) => (
              <tr key={workItem.id} className="align-top">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-100">
                    {workItem.title || "Untitled work item"}
                  </div>
                  <div className="mt-2">
                    <WorkItemFallbackBadge
                      workItemId={workItem.id}
                      cutovers={cutoversByWorkItemId.get(workItem.id) ?? []}
                    />
                  </div>
                  <div className="mt-1 max-w-xl truncate text-xs text-slate-500">
                    {workItem.description ||
                      workItem.instructions ||
                      workItem.id}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge value={workItem.state} />
                </td>
                <td className="px-4 py-3 text-slate-400">
                  {workItem.source || "unknown"}
                </td>
                <td className="px-4 py-3 text-slate-400">
                  <DetailChip value={workItem.runnerKind} />
                </td>
                <td className="px-4 py-3 text-slate-400">
                  <DetailChip value={workItem.repository} />
                </td>
                <td className="px-4 py-3 text-slate-400">
                  {plans.find((plan) => plan.id === workItem.planId)?.name ||
                    workItem.planId ||
                    "None"}
                </td>
                <td className="px-4 py-3 text-slate-400">
                  {formatDate(workItem.updatedAt)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    {workItem.snooze ? (
                      <SnoozedBadge
                        workspaceId={workspaceId}
                        workItem={workItem}
                        onWoken={onWorkItemUpdated}
                        onError={onError}
                        className="max-w-80 text-left"
                      />
                    ) : (
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
