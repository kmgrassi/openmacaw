import type { RuntimeTimelineEvent } from "../lib/runtime-events";
import { statusToneClass, statusToneForValue } from "./ui/status-tones";

type Props = {
  events: RuntimeTimelineEvent[];
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function RuntimeEventTimeline({ events }: Props) {
  if (events.length === 0) return null;

  return (
    <div className="space-y-1.5 border-l border-slate-800/80 pl-3">
      {events.map((event) => (
        <div
          key={event.id}
          className={`rounded-md border px-2.5 py-2 text-xs ${statusToneClass(
            statusToneForValue(event.status),
            "panel",
          )}`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusToneClass(
                statusToneForValue(event.status),
                "dot",
              )}`}
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {event.label}
            </span>
            <span className="shrink-0 font-mono text-[10px] opacity-65">
              {formatTime(event.timestamp)}
            </span>
          </div>
          {event.detail && (
            <div className="mt-1 [overflow-wrap:anywhere] text-[11px] leading-4 opacity-80">
              {event.detail}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
