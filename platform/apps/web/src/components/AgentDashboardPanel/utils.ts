import { isApprovalRequiredText } from "../ApprovalRequiredNotice";
import { formatStatusLabel as formatSharedStatusLabel } from "../../lib/status-labels";

export function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export function formatTimestamp(value: string | null | undefined) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(value: string | null | undefined) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";

  const diffMs = date.getTime() - Date.now();
  const absMinutes = Math.round(Math.abs(diffMs) / 60_000);
  if (absMinutes < 1) return "just now";
  if (absMinutes < 60) {
    return diffMs < 0 ? `${absMinutes}m ago` : `in ${absMinutes}m`;
  }

  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) {
    return diffMs < 0 ? `${absHours}h ago` : `in ${absHours}h`;
  }

  const absDays = Math.round(absHours / 24);
  return diffMs < 0 ? `${absDays}d ago` : `in ${absDays}d`;
}

export function statusVariant(
  status: string | null | undefined,
): "default" | "success" | "warning" | "error" {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (
    ["ok", "applied", "running", "completed", "done", "success"].includes(
      normalized,
    )
  )
    return "success";
  if (
    [
      "applying",
      "queued",
      "pending",
      "starting",
      "in_progress",
      "running_partial",
      "approval_required",
    ].includes(normalized)
  )
    return "warning";
  if (
    ["error", "failed", "cancelled", "canceled", "aborted"].includes(normalized)
  )
    return "error";
  return "default";
}

export function formatStatusLabel(status: string | null | undefined) {
  return formatSharedStatusLabel(status);
}

export function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(1)}s`;
}

export function formatCommandAction(value: string) {
  return value.replace(/[_-]+/g, " ");
}

export function toolEventTitle(event: {
  eventType: string;
  messageKind?: string;
  toolSlug: string;
}) {
  const type = event.eventType.replace(/[._-]+/g, " ");
  const kind =
    event.messageKind && event.messageKind !== "assistant_tool_call"
      ? ` • ${formatStatusLabel(event.messageKind)}`
      : "";
  return `${formatStatusLabel(type)}${kind} • ${event.toolSlug}`;
}

export function configStatusLabel(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (!normalized) return "Config unknown";
  if (normalized === "ok") return "Config ok";
  return `Config ${formatStatusLabel(normalized)}`;
}

export function runApprovalMessage(input: {
  error?: string | null;
  terminalReason?: string | null;
  lastEvent?: string | null;
  configApplyError?: string | null;
}) {
  const candidates = [
    input.error,
    input.terminalReason,
    input.lastEvent,
    input.configApplyError,
  ];
  return candidates.find(isApprovalRequiredText) ?? null;
}

export function formatToolEventSummary(task: {
  type: string | null;
  status: string | null;
  lastEvent: string | null;
  toolEvents?: Array<{
    eventType: string;
    messageKind: string;
    toolSlug: string;
    status: string;
    approvalState: string;
    commandActions: string[];
    outputSummary: string | null;
    patchSummary: string | null;
    errorMessage: string | null;
  }>;
}) {
  const event = task.toolEvents?.[task.toolEvents.length - 1] ?? null;
  if (!event) return task.lastEvent || task.type || "Task";

  const actionLabel =
    event.commandActions.length > 0
      ? ` (${event.commandActions.map(formatCommandAction).join(", ")})`
      : "";
  const summary =
    event.errorMessage ||
    event.patchSummary ||
    event.outputSummary ||
    event.status;
  return `${event.toolSlug}${actionLabel}: ${summary}`;
}
