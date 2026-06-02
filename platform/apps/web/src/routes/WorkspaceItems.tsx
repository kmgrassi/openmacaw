import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { type PlanRecord, type WorkItemProjection } from "../api/plans";
import {
  useDeletePlanMutation,
  useDeleteWorkItemMutation,
  usePlansQuery,
  useWorkItemsQuery,
} from "../api/query-hooks";
import { AppShell } from "../components/AppShell";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { useAuthStore } from "../stores/auth";
import { PlanDetailsPanel } from "./WorkspaceItems/PlanDetailsPanel";
import { PlansList } from "./WorkspaceItems/PlansList";
import { EmptyState, sortSnoozedLast } from "./WorkspaceItems/utils";
import { WorkItemsList } from "./WorkspaceItems/WorkItemsList";

type ViewMode = "plans" | "work-items";

export function WorkspaceItems() {
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const [mode, setMode] = useState<ViewMode>("plans");
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plansQuery = usePlansQuery(workspaceId);
  const workItemsQuery = useWorkItemsQuery(workspaceId);
  const deletePlanMutation = useDeletePlanMutation(workspaceId);
  const deleteWorkItemMutation = useDeleteWorkItemMutation(workspaceId);
  const plans = plansQuery.data ?? [];
  const workItems = workItemsQuery.data ?? [];
  const loading =
    plansQuery.isLoading ||
    workItemsQuery.isLoading ||
    plansQuery.isFetching ||
    workItemsQuery.isFetching;
  const deletingId =
    deletePlanMutation.isPending &&
    typeof deletePlanMutation.variables === "string"
      ? deletePlanMutation.variables
      : deleteWorkItemMutation.isPending &&
          typeof deleteWorkItemMutation.variables === "string"
        ? deleteWorkItemMutation.variables
        : null;

  const queryError = plansQuery.error ?? workItemsQuery.error;

  useEffect(() => {
    setSelectedPlanId(null);
  }, [workspaceId]);

  useEffect(() => {
    setError(queryError ? (queryError as Error).message : null);
  }, [queryError]);

  const workItemsByPlanId = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of workItems) {
      if (!item.planId) continue;
      map.set(item.planId, (map.get(item.planId) ?? 0) + 1);
    }
    return map;
  }, [workItems]);

  const selectedPlan = useMemo(
    () =>
      plans.find(
        (plan) =>
          plan.id === selectedPlanId && plan.workspaceId === workspaceId,
      ) ?? null,
    [plans, selectedPlanId, workspaceId],
  );

  const selectedPlanWorkItems = useMemo(() => {
    if (!selectedPlan) return [];
    return sortSnoozedLast(
      workItems.filter(
        (item) =>
          item.planId === selectedPlan.id && item.workspaceId === workspaceId,
      ),
    );
  }, [selectedPlan, workItems, workspaceId]);

  const sortedWorkItems = useMemo(
    () => sortSnoozedLast(workItems),
    [workItems],
  );

  async function handleDeletePlan(plan: PlanRecord) {
    if (!workspaceId) return;
    const name = plan.name || plan.id;
    if (!window.confirm(`Delete plan "${name}" and its work items?`)) return;
    setError(null);
    try {
      await deletePlanMutation.mutateAsync(plan.id);
      if (selectedPlanId === plan.id) {
        setSelectedPlanId(null);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDeleteWorkItem(workItem: WorkItemProjection) {
    if (!workspaceId) return;
    const title = workItem.title || workItem.id;
    if (!window.confirm(`Delete work item "${title}"?`)) return;
    setError(null);
    try {
      await deleteWorkItemMutation.mutateAsync(workItem.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function handleWorkItemUpdated(_nextWorkItem: WorkItemProjection) {
    setError(null);
  }

  function refresh() {
    setError(null);
    void plansQuery.refetch();
    void workItemsQuery.refetch();
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 md:p-6">
        <PageHeader
          title="Plans & work items"
          description={
            workspaceId ? `Workspace ${workspaceId}` : "No workspace selected"
          }
          variant="route"
          bordered
          stackAt="md"
          className="md:items-end"
          actions={
            <>
              <Button
                variant="secondary"
                onClick={refresh}
                loading={loading}
                disabled={!workspaceId}
              >
                Refresh
              </Button>
              <Link to="/plans/new">
                <Button>Create plan</Button>
              </Link>
            </>
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            ariaLabel="Plans and work items view"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "plans", label: "Plans" },
              { value: "work-items", label: "Work items" },
            ]}
            density="compact"
            tone="subtle"
          />
          <div className="text-sm text-slate-500">
            {plans.length} plans · {workItems.length} work items
          </div>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        {!workspaceId && (
          <EmptyState label="A workspace is required before plans and work items can load." />
        )}

        {workspaceId && mode === "plans" && (
          <PlansList
            plans={plans}
            loading={loading}
            selectedPlanId={selectedPlanId}
            deletingId={deletingId}
            workItemsByPlanId={workItemsByPlanId}
            onSelectPlan={setSelectedPlanId}
            onDeletePlan={(plan) => void handleDeletePlan(plan)}
          />
        )}

        {workspaceId && mode === "work-items" && (
          <WorkItemsList
            workspaceId={workspaceId}
            plans={plans}
            workItems={sortedWorkItems}
            loading={loading}
            deletingId={deletingId}
            onDeleteWorkItem={(workItem) => void handleDeleteWorkItem(workItem)}
            onWorkItemUpdated={handleWorkItemUpdated}
            onError={(message) => setError(message || null)}
          />
        )}
      </div>

      {selectedPlan && workspaceId && (
        <PlanDetailsPanel
          workspaceId={workspaceId}
          plan={selectedPlan}
          workItems={selectedPlanWorkItems}
          deletingId={deletingId}
          onClose={() => setSelectedPlanId(null)}
          onDeleteWorkItem={(workItem) => void handleDeleteWorkItem(workItem)}
          onWorkItemUpdated={handleWorkItemUpdated}
          onError={(message) => setError(message || null)}
        />
      )}
    </AppShell>
  );
}
