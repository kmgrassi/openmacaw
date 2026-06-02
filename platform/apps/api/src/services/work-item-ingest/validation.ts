import type { JsonObject } from "./types.js";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const record = asRecord(item);
      return asString(record?.name) ?? asString(record?.label) ?? "";
    })
    .filter((item) => item.length > 0);
}

export function toJsonObject(value: Record<string, unknown>): JsonObject {
  return value as JsonObject;
}

export function normalizeState(value: string | null, fallback = "todo"): string {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");

  if (["done", "completed", "complete", "closed"].includes(normalized)) return "done";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["in_progress", "started", "doing"].includes(normalized)) return "in_progress";
  if (["backlog", "todo", "triage", "open", "unstarted"].includes(normalized)) return "todo";

  return normalized;
}

export function normalizePriority(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().toLowerCase().replace(/\s+/g, "_");
  }

  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return null;
  }

  switch (value) {
    case 1:
      return "urgent";
    case 2:
      return "high";
    case 3:
      return "medium";
    case 4:
      return "low";
    default:
      return String(value);
  }
}

export function ensureWorkspaceId(workspaceId: string | null, context: string): string {
  if (!workspaceId) {
    throw new Error(`Could not resolve a workspace for ${context}`);
  }
  return workspaceId;
}

export function isRecentLinearWebhookTimestamp(timestamp: unknown, now = Date.now(), maxSkewMs = 60_000): boolean {
  return typeof timestamp === "number" && Math.abs(now - timestamp) <= maxSkewMs;
}
