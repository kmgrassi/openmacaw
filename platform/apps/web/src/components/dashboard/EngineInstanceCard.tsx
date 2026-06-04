import type { ReactNode } from "react";

import { formatStatusLabel } from "../../lib/status-labels";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import type { DashboardAgentHealth, DashboardSetup } from "./dashboardTypes";

type EngineInstanceCardProps = {
  setup: DashboardSetup | null;
  health: DashboardAgentHealth | null;
  detailsOpen: boolean;
  detailsEnabled: boolean;
  stopping: boolean;
  refreshing: boolean;
  onToggleDetails: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onViewDetails: () => void;
};

function formatUptime(startedAt: string | null | undefined) {
  if (!startedAt) return "Unknown";
  const deltaMs = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "Unknown";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "Just now";
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  return `${hours}h ${minutes % 60}m`;
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  const variant =
    status === "running" || status === "healthy" || status === "connected"
      ? "success"
      : status === "failed" ||
          status === "unhealthy" ||
          status === "connection_failed"
        ? "error"
        : status === "starting" ||
            status === "draining" ||
            status === "not_started"
          ? "warning"
          : "default";
  return <Badge variant={variant}>{formatStatusLabel(status)}</Badge>;
}

function getEngineStatusMeta(status: string | null | undefined) {
  switch (status) {
    case "running":
      return {
        label: "Running",
        explanation: "The engine is accepting dashboard and chat traffic.",
        dotClassName: "bg-green-400 shadow-[0_0_0_3px_rgba(74,222,128,0.12)]",
        moduleClassName: "border-green-500/30 bg-green-950/20",
      };
    case "healthy":
      return {
        label: "Healthy",
        explanation:
          "Health checks are passing and the engine is available for dashboard traffic.",
        dotClassName: "bg-green-400 shadow-[0_0_0_3px_rgba(74,222,128,0.12)]",
        moduleClassName: "border-green-500/30 bg-green-950/20",
      };
    case "starting":
      return {
        label: "Starting",
        explanation:
          "The launcher is preparing the engine; chat may connect once health checks pass.",
        dotClassName: "bg-yellow-400 shadow-[0_0_0_3px_rgba(250,204,21,0.12)]",
        moduleClassName: "border-yellow-500/30 bg-yellow-950/20",
      };
    case "draining":
      return {
        label: "Draining",
        explanation:
          "The engine is winding down existing work and may reject new traffic soon.",
        dotClassName: "bg-yellow-400 shadow-[0_0_0_3px_rgba(250,204,21,0.12)]",
        moduleClassName: "border-yellow-500/30 bg-yellow-950/20",
      };
    case "failed":
      return {
        label: "Failed",
        explanation:
          "The last engine start failed. Open details to inspect health and config state.",
        dotClassName: "bg-red-400 shadow-[0_0_0_3px_rgba(248,113,113,0.14)]",
        moduleClassName: "border-red-500/40 bg-red-950/30",
      };
    case "unhealthy":
      return {
        label: "Unhealthy",
        explanation:
          "Health checks are failing. Open details to inspect the latest health and config state.",
        dotClassName: "bg-red-400 shadow-[0_0_0_3px_rgba(248,113,113,0.14)]",
        moduleClassName: "border-red-500/40 bg-red-950/30",
      };
    case "stopped":
      return {
        label: "Stopped",
        explanation:
          "The engine is stopped, so chat traffic will not reach this instance.",
        dotClassName: "bg-slate-400 shadow-[0_0_0_3px_rgba(148,163,184,0.12)]",
        moduleClassName: "border-slate-700 bg-slate-950/30",
      };
    default:
      return {
        label: formatStatusLabel(status),
        explanation:
          "Runtime state is not available yet. Refresh to check for the latest engine report.",
        dotClassName: "bg-slate-500 shadow-[0_0_0_3px_rgba(100,116,139,0.12)]",
        moduleClassName: "border-slate-700 bg-slate-950/30",
      };
  }
}

function formatLayerLabel(layer: string | null | undefined) {
  if (!layer) return "Unknown layer";
  return formatStatusLabel(layer);
}

function getHealthStatusMeta(
  health: DashboardAgentHealth | null,
  fallbackStatus: string | null | undefined,
) {
  if (!health) return getEngineStatusMeta(fallbackStatus);

  const failureLayer = health.lastFailure?.sourceLayer;
  const failureMessage = health.lastFailure?.message;

  switch (health.status) {
    case "healthy":
      return {
        label: "Healthy",
        explanation:
          "Config, launcher, and runtime heartbeat are currently reporting healthy.",
        dotClassName: "bg-green-400 shadow-[0_0_0_3px_rgba(74,222,128,0.12)]",
        moduleClassName: "border-green-500/30 bg-green-950/20",
      };
    case "degraded":
      return {
        label: failureLayer
          ? `${formatLayerLabel(failureLayer)} degraded`
          : "Degraded",
        explanation:
          failureMessage ?? "One layer is reporting a recoverable issue.",
        dotClassName: "bg-yellow-400 shadow-[0_0_0_3px_rgba(250,204,21,0.12)]",
        moduleClassName: "border-yellow-500/30 bg-yellow-950/20",
      };
    case "unhealthy":
      return {
        label: failureLayer
          ? `${formatLayerLabel(failureLayer)} failure`
          : "Unhealthy",
        explanation:
          failureMessage ??
          "A required layer is failing or configuration is incomplete.",
        dotClassName: "bg-red-400 shadow-[0_0_0_3px_rgba(248,113,113,0.14)]",
        moduleClassName: "border-red-500/40 bg-red-950/30",
      };
    default:
      return getEngineStatusMeta(fallbackStatus);
  }
}

function EngineMetric({
  label,
  value,
  title,
}: {
  label: string;
  value: ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-slate-950/30 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className="mt-1 min-w-0 text-sm font-medium text-slate-200"
        title={title}
      >
        {value}
      </div>
    </div>
  );
}

export function EngineInstanceCard({
  setup,
  health,
  detailsOpen,
  detailsEnabled,
  stopping,
  refreshing,
  onToggleDetails,
  onStop,
  onRefresh,
  onViewDetails,
}: EngineInstanceCardProps) {
  const runtimeHealth = setup?.runtimeHealth;
  const runtimeTarget = runtimeHealth?.runtimeTarget;
  const fallbackStatus = runtimeHealth?.ok
    ? runtimeHealth.status
    : setup?.engine?.status;
  const engineStatusMeta = getHealthStatusMeta(health, fallbackStatus);
  const host = runtimeTarget?.host ?? setup?.engine?.host ?? "Unavailable";
  const port = runtimeTarget?.port ?? setup?.engine?.port ?? "Unavailable";
  const uptime = formatUptime(setup?.engine?.startedAt);
  const statusSource = runtimeHealth?.ok
    ? runtimeHealth.source === "launcher"
      ? "Launcher runtime"
      : "Engine instance"
    : "Engine instance";
  const databaseStatus = health?.database.status ?? "unknown";
  const databaseTitle =
    health?.database.lastError?.message ??
    (health?.database.connected
      ? "Elixir Repo can reach the configured database"
      : health?.database.configured === false
        ? "SUPABASE_POOLER is not configured for direct Elixir database access"
        : "Database connectivity has not been reported");
  const lastHealth =
    runtimeHealth?.checkedAt ??
    health?.runtime.lastHeartbeatAt ??
    setup?.engine?.lastHealthAt ??
    "Unavailable";
  const summaryContent = (
    <>
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${engineStatusMeta.dotClassName}`}
        aria-hidden="true"
      />
      <span className="shrink-0 text-sm font-semibold text-white">
        {engineStatusMeta.label}
      </span>
      <span className="text-slate-600" aria-hidden>
        ·
      </span>
      <span className="truncate text-sm text-slate-300" title={host}>
        {host}
      </span>
      <span className="text-slate-600" aria-hidden>
        ·
      </span>
      <span className="shrink-0 text-sm text-slate-400">{port}</span>
      <span className="text-slate-600" aria-hidden>
        ·
      </span>
      <span className="shrink-0 text-sm text-slate-400">{uptime} uptime</span>
    </>
  );

  return (
    <Card className="border-slate-800/70 bg-slate-900/55 p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        {detailsEnabled ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-expanded={detailsOpen}
            onClick={onToggleDetails}
          >
            {summaryContent}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {summaryContent}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {detailsEnabled && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-expanded={detailsOpen}
              onClick={onToggleDetails}
            >
              View details
              <svg
                aria-hidden="true"
                className={`h-3.5 w-3.5 transition-transform ${
                  detailsOpen ? "rotate-180" : ""
                }`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {detailsOpen && (
        <div className="border-t border-slate-800/80 px-3 py-3">
          <div
            className={`rounded-md border p-3 ${engineStatusMeta.moduleClassName}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="min-w-0 text-xs leading-5 text-slate-300">
                {engineStatusMeta.explanation}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={refreshing}
                  onClick={onRefresh}
                >
                  Refresh
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onViewDetails}
                >
                  Debug details
                </Button>
              </div>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <EngineMetric
              label="Host"
              title={host}
              value={<span className="block truncate">{host}</span>}
            />
            <EngineMetric label="Port" value={port} />
            <EngineMetric label="Uptime" value={uptime} />
            <EngineMetric label="Status source" value={statusSource} />
            <EngineMetric
              label="Last health"
              value={<span className="block truncate">{lastHealth}</span>}
              title={lastHealth}
            />
            <EngineMetric
              label="Config sync"
              value={
                <StatusBadge
                  status={
                    setup?.gatewayConfigState?.lastApplyStatus ??
                    setup?.gatewayConfigState?.syncStatus
                  }
                />
              }
            />
            <EngineMetric
              label="Launcher"
              value={
                <StatusBadge status={health?.launcher.status ?? "unknown"} />
              }
              title={
                health?.launcher.lastError?.message ??
                health?.launcher.service ??
                "Unavailable"
              }
            />
            <EngineMetric
              label="Database"
              value={<StatusBadge status={databaseStatus} />}
              title={databaseTitle}
            />
            <EngineMetric
              label="Failure layer"
              value={
                <span className="block truncate">
                  {formatLayerLabel(health?.lastFailure?.sourceLayer)}
                </span>
              }
              title={health?.lastFailure?.message ?? "No summarized failure"}
            />
          </div>
          <div className="mt-4">
            <Button
              variant="danger"
              className="w-full"
              onClick={onStop}
              loading={stopping}
              disabled={!setup?.engine?.instanceId}
            >
              Stop agent
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
