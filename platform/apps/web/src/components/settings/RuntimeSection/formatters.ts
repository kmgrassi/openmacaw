import type {
  ClaudeCodeDiagnosticStatus,
  CodexOAuthDiagnosticStatus,
} from "../../../api/agent-diagnostic";
import { formatStatusLabel as formatSharedStatusLabel } from "../../../lib/status-labels";

export function formatDateTime(value: string | null): string {
  if (!value) return "N/A";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

export function formatSessionTime(ts: number | null | undefined): string {
  if (!ts) return "\u2014";
  const value = typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts;
  return new Date(value).toLocaleString();
}

export function formatStatusLabel(status: string | null | undefined): string {
  return formatSharedStatusLabel(status);
}

export function formatExitStatus(
  exitStatus: number | null | undefined,
  fallbackStatus: string,
): string {
  return exitStatus === null || exitStatus === undefined
    ? formatStatusLabel(fallbackStatus)
    : String(exitStatus);
}

export function sessionStatusVariant(
  status: string,
): "default" | "success" | "warning" | "error" {
  if (status === "running") return "success";
  if (status === "stopped") return "default";
  if (status === "failed" || status === "error") return "error";
  return "warning";
}

export function claudeCodeStatusVariant(
  status: ClaudeCodeDiagnosticStatus,
): "default" | "success" | "warning" | "error" {
  if (status === "ready") return "success";
  if (status === "not_applicable") return "default";
  if (status === "runtime_bridge_startup_failed") return "error";
  return "warning";
}

export function codexOAuthStatusVariant(
  status: CodexOAuthDiagnosticStatus,
): "default" | "success" | "warning" | "error" {
  if (status === "ready") return "success";
  if (status === "not_applicable") return "default";
  if (status === "runtime_bridge_startup_failed" || status === "token_expired")
    return "error";
  return "warning";
}
