import { Link } from "react-router-dom";
import type { ManagerRuntimeStatus } from "../../../../../../contracts/manager-agent";
import type { Agent } from "../../../types/agents";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { providerLabel, type SchedulerRuntimeProvider } from "./utils";

type ManagerAgentStatusProps = {
  agentId: string | null;
  manager: Agent | null;
  provider: SchedulerRuntimeProvider;
  workspaceId: string | null;
  status: ManagerRuntimeStatus | null;
  statusError: string | null;
  missingRequirements: string[];
  onRefresh: () => void;
};

export function ManagerAgentStatus({
  agentId,
  manager,
  provider,
  workspaceId,
  status,
  statusError,
  missingRequirements,
  onRefresh,
}: ManagerAgentStatusProps) {
  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-slate-300">Live Status</h3>
          <p className="mt-1 text-xs text-slate-500">
            Runtime health from the platform proxy.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {agentId ? (
            <Link
              to={`/dashboard/${agentId}`}
              className="inline-flex items-center justify-center rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              View transcript
            </Link>
          ) : (
            <span
              aria-disabled
              title="Activate the manager agent to view its transcript."
              className="inline-flex cursor-not-allowed items-center justify-center rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-slate-500 opacity-50"
            >
              View transcript
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void onRefresh()}
            disabled={!workspaceId}
          >
            Refresh
          </Button>
        </div>
      </div>

      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-slate-500">Agent</span>
          <span className="min-w-0 truncate text-right text-slate-300">
            {manager?.name ?? agentId ?? "Not created"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-slate-500">Provider</span>
          <span className="truncate text-right text-slate-300">
            {providerLabel(provider)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-slate-500">Last tick</span>
          <span className="text-right text-slate-300">
            {status?.lastTickAt
              ? new Date(status.lastTickAt).toLocaleString()
              : "None"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-slate-500">Decisions</span>
          <span className="text-right text-slate-300">
            {status?.lastDecisionCount ?? "None"}
          </span>
        </div>
        <div>
          <div className="mb-1 text-slate-500">Missing</div>
          {missingRequirements.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {missingRequirements.map((item) => (
                <Badge key={item} variant="warning">
                  {item}
                </Badge>
              ))}
            </div>
          ) : (
            <div className="text-slate-300">None</div>
          )}
        </div>
      </div>

      {(status?.error || statusError) && (
        <div className="mt-4 rounded-md border border-red-600/30 bg-red-900/20 px-3 py-2 text-sm text-red-300">
          {status?.error ?? statusError}
        </div>
      )}
    </Card>
  );
}
