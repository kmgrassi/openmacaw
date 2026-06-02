import { getServiceRoleSupabase, normalizeSupabaseError } from "../../supabase-client.js";

export type WorkItemDiagnosticRow = {
  id: string;
  title: string | null;
  state: string;
  next_poll_at: string | null;
  last_polled_at: string | null;
  poll_cadence_seconds: number;
  updated_at: string;
};

export type SnoozeEventDiagnosticRow = {
  id: string;
  created_at: string;
  kind: string;
  source: string;
  payload: unknown;
  raw_payload: unknown;
  work_item_id: string;
  workspace_id: string;
};

export type WorkItemSnoozeDiagnostic = {
  queriedWorkItemId: string | null;
  count: number;
  items: Array<{
    id: string;
    title: string | null;
    state: string;
    nextPollAt: string | null;
    lastPolledAt: string | null;
    pollCadenceSeconds: number;
    updatedAt: string;
    latestSnoozeEvent: {
      id: string;
      createdAt: string;
      kind: string;
      source: string;
      payload: unknown;
      rawPayload: unknown;
    } | null;
  }>;
};

export function buildWorkItemSnoozeDiagnostic(input: {
  queriedWorkItemId: string | null;
  workItems: WorkItemDiagnosticRow[];
  snoozeEvents: SnoozeEventDiagnosticRow[];
}): WorkItemSnoozeDiagnostic {
  const latestSnoozeEventByWorkItemId = new Map<string, SnoozeEventDiagnosticRow>();

  for (const event of input.snoozeEvents) {
    const existing = latestSnoozeEventByWorkItemId.get(event.work_item_id);
    if (!existing || Date.parse(event.created_at) > Date.parse(existing.created_at)) {
      latestSnoozeEventByWorkItemId.set(event.work_item_id, event);
    }
  }

  return {
    queriedWorkItemId: input.queriedWorkItemId,
    count: input.workItems.length,
    items: input.workItems.map((workItem) => {
      const latestSnoozeEvent = latestSnoozeEventByWorkItemId.get(workItem.id) ?? null;

      return {
        id: workItem.id,
        title: workItem.title,
        state: workItem.state,
        nextPollAt: workItem.next_poll_at,
        lastPolledAt: workItem.last_polled_at,
        pollCadenceSeconds: workItem.poll_cadence_seconds,
        updatedAt: workItem.updated_at,
        latestSnoozeEvent: latestSnoozeEvent
          ? {
              id: latestSnoozeEvent.id,
              createdAt: latestSnoozeEvent.created_at,
              kind: latestSnoozeEvent.kind,
              source: latestSnoozeEvent.source,
              payload: latestSnoozeEvent.payload,
              rawPayload: latestSnoozeEvent.raw_payload,
            }
          : null,
      };
    }),
  };
}

export async function loadWorkItemSnoozeDiagnostic(input: {
  workspaceId: string | null;
  workItemId: string | null;
}): Promise<WorkItemSnoozeDiagnostic | null> {
  if (!input.workspaceId) return null;

  const supabase = getServiceRoleSupabase();
  let workItemQuery = supabase
    .from("work_items")
    .select("id, title, state, next_poll_at, last_polled_at, poll_cadence_seconds, updated_at")
    .eq("workspace_id", input.workspaceId)
    .order("updated_at", { ascending: false })
    .limit(input.workItemId ? 1 : 25);

  if (input.workItemId) {
    workItemQuery = workItemQuery.eq("id", input.workItemId);
  }

  const { data: workItemData, error: workItemError } = await workItemQuery;
  if (workItemError) throw normalizeSupabaseError("work_items diagnostic query", workItemError);

  const workItems = (workItemData ?? []) as WorkItemDiagnosticRow[];
  const workItemIds = workItems.map((workItem) => workItem.id);
  if (workItemIds.length === 0) {
    return buildWorkItemSnoozeDiagnostic({
      queriedWorkItemId: input.workItemId,
      workItems,
      snoozeEvents: [],
    });
  }

  const { data: snoozeEventData, error: snoozeEventError } = await supabase
    .from("event_log")
    .select("id, created_at, kind, source, payload, raw_payload, work_item_id, workspace_id")
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "work_item.snoozed")
    .in("work_item_id", workItemIds)
    .order("created_at", { ascending: false });

  if (snoozeEventError) throw normalizeSupabaseError("event_log snooze diagnostic query", snoozeEventError);

  return buildWorkItemSnoozeDiagnostic({
    queriedWorkItemId: input.workItemId,
    workItems,
    snoozeEvents: (snoozeEventData ?? []) as SnoozeEventDiagnosticRow[],
  });
}
