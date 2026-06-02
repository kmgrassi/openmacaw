import type { AgentMessageToolCall } from "../../../../contracts/messages";
import {
  formatMetadataToolCall,
  formatPersistedToolCalls,
  type ToolCallDisplay,
} from "./tool-call-rendering";

export type ManagerToolCallDisplay = ToolCallDisplay;

export type ManagerSchedulerMessageDisplay = {
  summary: string;
  workItemIds: string[];
  toolCalls: ManagerToolCallDisplay[];
  rawPayload: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(content));
  } catch {
    return null;
  }
}

function dueTaskCount(
  metadata: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): number {
  const metadataIds = stringArray(metadata.work_item_ids);
  if (metadataIds.length > 0) return metadataIds.length;

  const payloadIds = stringArray(payload?.work_item_ids);
  if (payloadIds.length > 0) return payloadIds.length;

  const dueTasks = payload?.due_tasks;
  if (Array.isArray(dueTasks)) return dueTasks.length;

  return 0;
}

function toolCallsFromMetadata(
  metadata: Record<string, unknown>,
): ManagerToolCallDisplay[] {
  const rawToolCalls = metadata.tool_calls ?? metadata.toolCalls;
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls
    .map((toolCall, index) => formatMetadataToolCall(toolCall, index))
    .filter(
      (toolCall): toolCall is ManagerToolCallDisplay => toolCall !== null,
    );
}

function rawPayloadForDetails(
  content: string,
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return content.trim() ? content : null;
  return JSON.stringify(payload, null, 2) ?? content;
}

export function getManagerSchedulerMessageDisplay(
  content: string,
  metadata: unknown,
  persistedToolCalls: AgentMessageToolCall[] = [],
): ManagerSchedulerMessageDisplay | null {
  const metadataRecord = asRecord(metadata);
  if (
    metadataRecord?.source !== "manager_scheduler" ||
    metadataRecord.kind !== "due_tasks"
  ) {
    return null;
  }

  const payload = parseJsonRecord(content);
  const count = dueTaskCount(metadataRecord, payload);
  const workItemIds = [
    ...new Set([
      ...stringArray(metadataRecord.work_item_ids),
      ...stringArray(payload?.work_item_ids),
    ]),
  ];
  const noun = count === 1 ? "due task" : "due tasks";

  return {
    summary: `Manager checked ${count} ${noun}`,
    workItemIds,
    toolCalls:
      persistedToolCalls.length > 0
        ? formatPersistedToolCalls(persistedToolCalls)
        : toolCallsFromMetadata(metadataRecord),
    rawPayload: rawPayloadForDetails(content, payload),
  };
}
