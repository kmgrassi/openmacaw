import { CodingHandoffRequestSchema, type CodingHandoffRequest } from "../../../../contracts/credentials.js";
import { ApiRouteError } from "../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";

export function parseCodingHandoff(input: unknown, required: boolean): CodingHandoffRequest | null {
  const raw =
    input && typeof input === "object" && "handoff" in input ? (input as { handoff?: unknown }).handoff : null;
  if (raw == null) {
    if (!required) return null;
    throw new ApiRouteError(
      400,
      "planning_handoff_required",
      "A reviewed plan ID and at least one task ID are required to launch coding from planner output",
    );
  }

  const parsed = CodingHandoffRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiRouteError(
      400,
      "invalid_planning_handoff",
      "handoff.planId and handoff.taskIds are required",
      parsed.error.flatten(),
    );
  }

  return {
    planId: parsed.data.planId,
    taskIds: Array.from(new Set(parsed.data.taskIds)),
  };
}

export async function assertCodingHandoffReviewable(input: { workspaceId: string; handoff: CodingHandoffRequest }) {
  const plans = await executeSupabaseRows<{ id: string; status: string | null }>(
    "plan query",
    getServiceRoleSupabase().from("plan").select("id,status").eq("id", input.handoff.planId).limit(1),
  );
  if (plans.length === 0) {
    throw new ApiRouteError(404, "plan_not_found", "Selected plan was not found");
  }

  const workItems = await executeSupabaseRows<{ id: string; plan_id: string | null; workspace_id: string | null }>(
    "work_items query",
    getServiceRoleSupabase()
      .from("work_items")
      .select("id,plan_id,workspace_id")
      .in("id", input.handoff.taskIds)
      .eq("plan_id", input.handoff.planId)
      .eq("workspace_id", input.workspaceId),
  );
  const foundIds = new Set(workItems.map((workItem) => workItem.id));
  const missingIds = input.handoff.taskIds.filter((taskId) => !foundIds.has(taskId));

  if (missingIds.length > 0) {
    throw new ApiRouteError(
      400,
      "invalid_planning_handoff",
      "Every selected task must belong to the selected plan and workspace",
      { missingTaskIds: missingIds },
    );
  }
}

export function codingHandoffEnv(handoff: CodingHandoffRequest | null): Record<string, string> {
  if (!handoff) return {};
  return {
    PLANNER_HANDOFF_APPROVED: "1",
    PLANNER_APPROVED_PLAN_ID: handoff.planId,
    PLANNER_APPROVED_TASK_IDS: handoff.taskIds.join(","),
  };
}
