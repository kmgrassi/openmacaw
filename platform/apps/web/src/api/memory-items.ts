import {
  MemoryItemListResponseSchema,
  type MemoryItem,
  type MemoryScope,
} from "../../../../contracts/memory-items";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export type { MemoryItem, MemoryScope };

export type MemoryItemFilters = {
  agentId?: string | null;
  scope?: MemoryScope;
  importanceMin?: number;
  sourceRunId?: string;
  limit?: number;
};

export function listMemoryItems(
  workspaceId: string,
  filters: MemoryItemFilters,
): Promise<{ memoryItems: MemoryItem[] }> {
  return apiFetch(ROUTES.workspaceMemoryItems(workspaceId, filters), {
    schema: MemoryItemListResponseSchema,
    defaultErrorMessage: "Could not load memory items.",
  });
}
