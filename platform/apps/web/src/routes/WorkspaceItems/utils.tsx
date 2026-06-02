import type { WorkItemProjection } from "../../api/plans";
import { EmptyState as UiEmptyState } from "../../components/ui/EmptyState";
import { StatusBadge as UiStatusBadge } from "../../components/ui/StatusBadge";
import {
  statusToneClass,
  statusToneForValue,
} from "../../components/ui/status-tones";

export function formatDate(value: string | null | undefined) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function statusClass(value: string | null | undefined) {
  return statusToneClass(statusToneForValue(value), "pill");
}

export function StatusBadge({ value }: { value: string | null | undefined }) {
  return <UiStatusBadge value={value} />;
}

export function EmptyState({ label }: { label: string }) {
  return <UiEmptyState label={label} />;
}

export function DetailChip({ value }: { value: string | null | undefined }) {
  if (!value) return null;

  return (
    <span className="inline-flex max-w-48 items-center truncate rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-300">
      {value}
    </span>
  );
}

export function sortSnoozedLast(items: WorkItemProjection[]) {
  return [...items].sort((a, b) => {
    if (Boolean(a.snooze) === Boolean(b.snooze)) return 0;
    return a.snooze ? 1 : -1;
  });
}
