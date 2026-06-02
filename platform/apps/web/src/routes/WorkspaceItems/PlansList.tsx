import type { PlanRecord } from "../../api/plans";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { EmptyState, formatDate, StatusBadge } from "./utils";

type Props = {
  plans: PlanRecord[];
  loading: boolean;
  selectedPlanId: string | null;
  deletingId: string | null;
  workItemsByPlanId: Map<string, number>;
  onSelectPlan: (planId: string) => void;
  onDeletePlan: (plan: PlanRecord) => void;
};

export function PlansList({
  plans,
  loading,
  selectedPlanId,
  deletingId,
  workItemsByPlanId,
  onSelectPlan,
  onDeletePlan,
}: Props) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {plans.length === 0 && !loading ? (
        <EmptyState label="No plans found for this workspace." />
      ) : (
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Work items</th>
              <th className="px-4 py-3 font-medium">Updated</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-slate-950">
            {plans.map((plan) => (
              <tr
                key={plan.id}
                tabIndex={0}
                onClick={() => onSelectPlan(plan.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectPlan(plan.id);
                  }
                }}
                className={cn(
                  "cursor-pointer align-top transition-colors hover:bg-slate-900/70 focus:bg-slate-900/70 focus:outline-none",
                  selectedPlanId === plan.id && "bg-slate-900",
                )}
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-100">
                    {plan.name || "Untitled plan"}
                  </div>
                  <div className="mt-1 max-w-2xl truncate text-xs text-slate-500">
                    {plan.description || plan.intent || plan.id}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge value={plan.status} />
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {workItemsByPlanId.get(plan.id) ?? 0}
                </td>
                <td className="px-4 py-3 text-slate-400">
                  {formatDate(plan.updatedAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={deletingId === plan.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeletePlan(plan);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
