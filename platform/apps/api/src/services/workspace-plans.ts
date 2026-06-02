import type { Tables } from "@kmgrassi/supabase-schema";

import {
  PlanDeleteResponseSchema,
  PlanListResponseSchema,
  type PlanDeleteResponse,
  type PlanListResponse,
} from "../../../../contracts/plans.js";
import {
  WorkItemDeleteResponseSchema,
  WorkItemListResponseSchema,
  type WorkItemDeleteResponse,
  type WorkItemListResponse,
} from "../../../../contracts/work-items.js";
import { ApiRouteError } from "../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { mapPlanRow, mapWorkItemRow } from "./plans.js";

type PlanRow = Tables<"plan">;
type WorkItemRow = Tables<"work_items">;
type EventLogRow = Tables<"event_log">;

export async function listPlansForWorkspace(workspaceId: string): Promise<PlanListResponse> {
  const plans = await executeSupabaseRows<PlanRow>(
    "plan list",
    getServiceRoleSupabase()
      .from("plan")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false }),
  );

  return PlanListResponseSchema.parse({ plans: plans.map(mapPlanRow) });
}

export async function deletePlanForWorkspace(workspaceId: string, planId: string): Promise<PlanDeleteResponse> {
  const plans = await executeSupabaseRows<PlanRow>(
    "plan lookup",
    getServiceRoleSupabase().from("plan").select("*").eq("workspace_id", workspaceId).eq("id", planId).limit(1),
  );
  const plan = plans[0];
  if (!plan) {
    throw new ApiRouteError(404, "plan_not_found", "Plan was not found in this workspace");
  }

  await executeSupabaseRows(
    "work_items delete for plan",
    getServiceRoleSupabase()
      .from("work_items")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("plan_id", planId)
      .select("id"),
  );
  await executeSupabaseRows(
    "plan delete",
    getServiceRoleSupabase().from("plan").delete().eq("workspace_id", workspaceId).eq("id", planId).select("id"),
  );

  return PlanDeleteResponseSchema.parse({ deleted: true, plan: mapPlanRow(plan) });
}

export async function listWorkItemsForWorkspace(workspaceId: string): Promise<WorkItemListResponse> {
  const workItems = await executeSupabaseRows<WorkItemRow>(
    "work_items list",
    getServiceRoleSupabase()
      .from("work_items")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false }),
  );

  const workItemIds = workItems.map((workItem) => workItem.id);
  const snoozeStateEvents =
    workItemIds.length === 0
      ? []
      : await executeSupabaseRows<EventLogRow>(
          "work_item snooze events list",
          getServiceRoleSupabase()
            .from("event_log")
            .select("*")
            .eq("workspace_id", workspaceId)
            .in("work_item_id", workItemIds)
            .in("kind", ["work_item.snoozed", "work_item.woken"])
            .order("created_at", { ascending: false }),
        );
  const latestSnoozeStateEventByWorkItem = new Map<string, EventLogRow>();
  for (const event of snoozeStateEvents) {
    if (!latestSnoozeStateEventByWorkItem.has(event.work_item_id)) {
      latestSnoozeStateEventByWorkItem.set(event.work_item_id, event);
    }
  }

  return WorkItemListResponseSchema.parse({
    workItems: workItems.map((workItem) => mapWorkItemRow(workItem, latestSnoozeStateEventByWorkItem.get(workItem.id))),
  });
}

export async function deleteWorkItemForWorkspace(
  workspaceId: string,
  workItemId: string,
): Promise<WorkItemDeleteResponse> {
  const rows = await executeSupabaseRows<WorkItemRow>(
    "work_items delete",
    getServiceRoleSupabase()
      .from("work_items")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("id", workItemId)
      .select("*"),
  );
  const workItem = rows[0];
  if (!workItem) {
    throw new ApiRouteError(404, "work_item_not_found", "Work item was not found in this workspace");
  }

  return WorkItemDeleteResponseSchema.parse({ deleted: true, workItem: mapWorkItemRow(workItem) });
}
