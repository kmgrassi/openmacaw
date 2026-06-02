import { WorkItemIngestResponseSchema, type WorkItemIngestResponse } from "../../../../../contracts/work-items.js";
import { mapWorkItemRow } from "../plans.js";
import type { PersistedWorkItem } from "./types.js";

export function mapWorkItemIngestResponse(saved: PersistedWorkItem): WorkItemIngestResponse {
  return WorkItemIngestResponseSchema.parse({
    workItem: saved.workItem ? mapWorkItemRow(saved.workItem) : null,
  });
}
