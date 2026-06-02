import type {
  BrokerRunRow,
  GatewayConfigStateRow,
} from "../../api/agent-dashboard";
import type { TaskUsageSummary } from "../../hooks/useAgentDashboard";
import { ApprovalRequiredNotice } from "../ApprovalRequiredNotice";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import {
  formatNumber,
  formatRelative,
  formatStatusLabel,
  formatTimestamp,
  statusVariant,
} from "./utils";

type Props = {
  latestRun: BrokerRunRow | null;
  latestRunSummary: TaskUsageSummary | null;
  configState: GatewayConfigStateRow | null;
  approvalMessage: string | null;
};

export function LatestRunCard({
  latestRun,
  latestRunSummary,
  configState,
  approvalMessage,
}: Props) {
  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Latest run
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-xs text-slate-300">
              {latestRun?.runId ? latestRun.runId.slice(0, 8) : "None"}
            </span>
            {latestRun && (
              <Badge variant={statusVariant(latestRun.status)}>
                {formatStatusLabel(latestRun.status)}
              </Badge>
            )}
          </div>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>Updated {formatRelative(latestRun?.updatedAt)}</div>
          <div>Applied {formatRelative(configState?.lastApplyAt)}</div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">
            Retries
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {latestRun
              ? Math.max(
                  (latestRun.attempt ?? 1) - 1,
                  latestRunSummary?.retryCount ?? 0,
                )
              : 0}
          </div>
        </div>
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">
            Input
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {formatNumber(latestRunSummary?.inputTokens)}
          </div>
        </div>
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">
            Output
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {formatNumber(latestRunSummary?.outputTokens)}
          </div>
        </div>
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">
            Total
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {formatNumber(latestRunSummary?.totalTokens)}
          </div>
        </div>
      </div>

      <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
        <div>
          Started:{" "}
          <span className="text-slate-300">
            {formatTimestamp(latestRun?.startedAt ?? latestRun?.createdAt)}
          </span>
        </div>
        <div>
          Finished:{" "}
          <span className="text-slate-300">
            {formatTimestamp(latestRun?.completedAt)}
          </span>
        </div>
        <div>
          Last task event:{" "}
          <span className="text-slate-300">
            {latestRunSummary?.lastEvent ?? "N/A"}
          </span>
        </div>
        <div>
          Tasks:{" "}
          <span className="text-slate-300">
            {latestRunSummary?.taskCount ?? 0}
          </span>
        </div>
      </div>

      {(latestRun?.error ||
        latestRun?.terminalReason ||
        configState?.lastApplyError) &&
        (approvalMessage ? (
          <ApprovalRequiredNotice message={approvalMessage} />
        ) : (
          <div className="rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
            {latestRun?.error ||
              latestRun?.terminalReason ||
              configState?.lastApplyError}
          </div>
        ))}
    </Card>
  );
}
