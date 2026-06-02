import type { Json, Tables, TablesInsert } from "@kmgrassi/supabase-schema";

import {
  SnoozeWorkItemResponseSchema,
  type SnoozeWorkItemRequest,
  type SnoozeWorkItemResponse,
} from "../../../../contracts/work-item-snooze.js";
import { ApiRouteError } from "../http.js";
import { assertSupabaseSuccess } from "../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { mapWorkItemRow } from "./plans.js";

const INDEFINITE_SNOOZE_UNTIL = "9999-01-01T00:00:00.000Z";

type EventLogRow = Tables<"event_log">;
type WorkItemRow = Tables<"work_items">;

function normalizeReason(reason: string | undefined): string | null {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : null;
}

function resolveSnoozeUntil(input: SnoozeWorkItemRequest, now = new Date()) {
  if (input.indefinite === true) {
    return { until: INDEFINITE_SNOOZE_UNTIL, indefinite: true };
  }

  if (typeof input.seconds === "number") {
    return {
      until: new Date(now.getTime() + input.seconds * 1000).toISOString(),
      indefinite: false,
    };
  }

  if (!input.until) {
    throw new ApiRouteError(400, "invalid_request", "Exactly one of until, seconds, or indefinite is required");
  }

  const until = new Date(input.until);
  if (!Number.isFinite(until.getTime())) {
    throw new ApiRouteError(400, "invalid_snooze_until", "Snooze until must be a valid ISO timestamp");
  }
  if (until.getTime() <= now.getTime()) {
    throw new ApiRouteError(400, "invalid_snooze_until", "Snooze until must be in the future");
  }

  return { until: until.toISOString(), indefinite: false };
}

async function fetchWorkItem(workspaceId: string, workItemId: string): Promise<WorkItemRow> {
  const { data, error } = await getServiceRoleSupabase()
    .from("work_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", workItemId)
    .limit(1);
  assertSupabaseSuccess("work_items lookup", data, error);

  const row = data[0] ?? null;
  if (!row) {
    throw new ApiRouteError(404, "work_item_not_found", "Work item was not found in this workspace");
  }
  return row;
}

async function insertEventLog(input: TablesInsert<"event_log">): Promise<EventLogRow> {
  const { data, error } = await getServiceRoleSupabase()
    .from("event_log")
    .insert(input)
    .select("*")
    .order("id", { ascending: true })
    .limit(1);
  assertSupabaseSuccess("event_log insert", data, error);

  const row = data[0] ?? null;
  if (!row) {
    throw new ApiRouteError(502, "event_log_insert_failed", "Event log insert returned no row");
  }
  return row;
}

async function restoreWorkItemPollState(
  workspaceId: string,
  workItemId: string,
  prior: Pick<WorkItemRow, "next_poll_at" | "updated_at">,
) {
  await getServiceRoleSupabase()
    .from("work_items")
    .update({ next_poll_at: prior.next_poll_at, updated_at: prior.updated_at })
    .eq("workspace_id", workspaceId)
    .eq("id", workItemId);
}

export async function snoozeWorkItemForWorkspace(input: {
  request: SnoozeWorkItemRequest;
  userId: string;
}): Promise<SnoozeWorkItemResponse> {
  const prior = await fetchWorkItem(input.request.workspaceId, input.request.workItemId);

  const now = new Date();
  const resolved = resolveSnoozeUntil(input.request, now);
  const reason = normalizeReason(input.request.reason);

  const { data, error } = await getServiceRoleSupabase()
    .from("work_items")
    .update({
      next_poll_at: resolved.until,
      updated_at: now.toISOString(),
    })
    .eq("workspace_id", input.request.workspaceId)
    .eq("id", input.request.workItemId)
    .select("*")
    .order("id", { ascending: true })
    .limit(1);
  assertSupabaseSuccess("work_items snooze", data, error);

  const workItem = data[0] ?? null;
  if (!workItem) {
    throw new ApiRouteError(404, "work_item_not_found", "Work item was not found in this workspace");
  }

  let event: EventLogRow;
  try {
    event = await insertEventLog({
      workspace_id: input.request.workspaceId,
      work_item_id: input.request.workItemId,
      kind: "work_item.snoozed",
      source: "platform_api",
      payload: {
        actor: { kind: "user", user_id: input.userId },
        reason,
        until: resolved.until,
        indefinite: resolved.indefinite,
        snoozed_at: now.toISOString(),
      } as Json,
    });
  } catch (eventError) {
    await restoreWorkItemPollState(input.request.workspaceId, input.request.workItemId, prior).catch(() => undefined);
    throw eventError;
  }

  return SnoozeWorkItemResponseSchema.parse({
    workItem: mapWorkItemRow(workItem, event),
  });
}

export async function wakeWorkItemForWorkspace(input: {
  workspaceId: string;
  workItemId: string;
  userId: string;
}): Promise<SnoozeWorkItemResponse> {
  const prior = await fetchWorkItem(input.workspaceId, input.workItemId);

  const now = new Date();
  const { data, error } = await getServiceRoleSupabase()
    .from("work_items")
    .update({ next_poll_at: null, updated_at: now.toISOString() })
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.workItemId)
    .select("*")
    .order("id", { ascending: true })
    .limit(1);
  assertSupabaseSuccess("work_items wake", data, error);

  const workItem = data[0] ?? null;
  if (!workItem) {
    throw new ApiRouteError(404, "work_item_not_found", "Work item was not found in this workspace");
  }

  try {
    await insertEventLog({
      workspace_id: input.workspaceId,
      work_item_id: input.workItemId,
      kind: "work_item.woken",
      source: "platform_api",
      payload: {
        actor: { kind: "user", user_id: input.userId },
        woken_at: now.toISOString(),
      } as Json,
    });
  } catch (eventError) {
    await restoreWorkItemPollState(input.workspaceId, input.workItemId, prior).catch(() => undefined);
    throw eventError;
  }

  return SnoozeWorkItemResponseSchema.parse({
    workItem: mapWorkItemRow(workItem, null),
  });
}
