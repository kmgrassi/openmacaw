import type { Session } from "../hooks/useSessions";
import { selectVisibleSessions } from "../lib/session-list-filter";

type Props = {
  sessions: Session[];
  activeKey: string;
  onSelect: (key: string) => void;
  onNewChat: () => void;
  readOnly?: boolean;
};

export function SessionList({
  sessions,
  activeKey,
  onSelect,
  onNewChat,
  readOnly = false,
}: Props) {
  const visibleSessions = selectVisibleSessions(sessions, activeKey, readOnly);

  return (
    <div className="space-y-1 px-2">
      {!readOnly && (
        <button
          onClick={onNewChat}
          className="w-full rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-slate-400 hover:border-blue-500 hover:text-blue-400 transition-colors"
        >
          + New Chat
        </button>
      )}
      {visibleSessions.map((session) => (
        <button
          key={session.key}
          onClick={() => onSelect(session.key)}
          className={`w-full rounded-lg px-3 py-1.5 text-left text-xs transition-colors ${
            activeKey === session.key
              ? "bg-surface-overlay text-slate-200"
              : "text-slate-400 hover:bg-surface-raised"
          }`}
        >
          <div className="truncate">{session.label || session.key}</div>
        </button>
      ))}
    </div>
  );
}
