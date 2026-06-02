import type { BrokerTaskRow } from "../../api/agent-dashboard";
import { Badge } from "../ui/Badge";
import {
  formatCommandAction,
  formatDuration,
  formatStatusLabel,
  statusVariant,
  toolEventTitle,
} from "./utils";

type ToolEvent = BrokerTaskRow["toolEvents"][number];

type Props = {
  event: ToolEvent;
};

export function ToolEventRow({ event }: Props) {
  const summary =
    event.errorMessage ||
    event.patchSummary ||
    event.outputSummary ||
    (event.fileChanges && event.fileChanges.length > 0
      ? `${event.fileChanges.length} file change${
          event.fileChanges.length === 1 ? "" : "s"
        }`
      : null);
  const duration = formatDuration(event.durationMs);
  const showApproval =
    event.approvalState && event.approvalState !== "not_required";

  return (
    <div className="rounded-md border border-border/80 bg-surface/70 px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-300">
            {toolEventTitle(event)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-500">
            {event.commandActions.length > 0 && (
              <span>
                {event.commandActions.map(formatCommandAction).join(", ")}
              </span>
            )}
            {duration && <span>{duration}</span>}
            {event.correlationId && (
              <span className="font-mono">
                corr {event.correlationId.slice(0, 12)}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showApproval && (
            <Badge variant={statusVariant(event.approvalState)}>
              {formatStatusLabel(event.approvalState)}
            </Badge>
          )}
          <Badge variant={statusVariant(event.status)}>
            {formatStatusLabel(event.status)}
          </Badge>
        </div>
      </div>
      {summary && (
        <div className="mt-2 whitespace-pre-wrap break-words text-slate-400">
          {summary}
        </div>
      )}
    </div>
  );
}
