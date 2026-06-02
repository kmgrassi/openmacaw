import { useMemo, useState } from "react";

import type { WorkItemProjection, WorkItemSnooze } from "../../api/plans";
import { useWakeWorkItemMutation } from "../../api/query-hooks";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";

type Props = {
  workspaceId: string;
  workItem: WorkItemProjection;
  onWoken: (workItem: WorkItemProjection) => void;
  onError?: (message: string) => void;
  className?: string;
};

function formatAbsolute(value: string | null | undefined) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelative(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  const diffMs = date.getTime() - Date.now();
  if (Number.isNaN(diffMs)) return null;
  const absMs = Math.abs(diffMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  });
  for (const [unit, unitMs] of units) {
    if (absMs >= unitMs || unit === "minute") {
      return formatter.format(Math.round(diffMs / unitMs), unit);
    }
  }
  return null;
}

function actorLabel(snooze: WorkItemSnooze) {
  if (snooze.snoozedBy.kind === "user") return "User";
  return "Agent";
}

export function SnoozedBadge({
  workspaceId,
  workItem,
  onWoken,
  onError,
  className,
}: Props) {
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snooze = workItem.snooze;
  const wakeMutation = useWakeWorkItemMutation(workspaceId);

  const relative = useMemo(
    () => formatRelative(workItem.nextPollAt),
    [workItem.nextPollAt],
  );

  if (!snooze) return null;

  async function handleWake() {
    setWaking(true);
    setError(null);
    onError?.("");
    try {
      const response = await wakeMutation.mutateAsync(workItem.id);
      onWoken(response.workItem);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      onError?.(message);
    } finally {
      setWaking(false);
    }
  }

  return (
    <div
      className={cn(
        "inline-flex max-w-full flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">
          {snooze.indefinite
            ? "Snoozed indefinitely"
            : `Snoozed ${relative ?? ""}`.trim()}
        </span>
        {!snooze.indefinite && (
          <span className="text-amber-200/80">
            until {formatAbsolute(workItem.nextPollAt)}
          </span>
        )}
      </div>
      <div className="text-amber-200/75">
        {actorLabel(snooze)}
        {snooze.reason ? `: ${snooze.reason}` : ""}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-amber-200/60">
          May be woken early by repo activity.
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={waking}
          onClick={() => void handleWake()}
        >
          Wake now
        </Button>
      </div>
      {error && <div className="text-red-200">{error}</div>}
    </div>
  );
}
