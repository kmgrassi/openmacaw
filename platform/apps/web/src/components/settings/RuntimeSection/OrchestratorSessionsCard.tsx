import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../../ui/KeyValueGrid";
import { SurfaceList, SurfaceListItem } from "../../ui/SurfaceList";
import { formatSessionTime } from "./formatters";

type SessionSummary = {
  key: string;
  kind: string;
  label?: string;
  displayName?: string;
  updatedAt: number | null;
};

export function OrchestratorSessionsCard({
  error,
  hasSessions,
  recentSessions,
  sessionCount,
}: {
  error: Error | null;
  hasSessions: boolean | null;
  recentSessions: SessionSummary[];
  sessionCount: number | null;
}) {
  return (
    <Card>
      <h3 className="text-sm font-medium text-slate-300 mb-3">
        Orchestrator sessions
      </h3>
      {error ? (
        <p className="text-sm text-red-400">{error.message}</p>
      ) : (
        <div className="space-y-3">
          <KeyValueGrid className="text-sm">
            <KeyValuePair label="Present">
              {hasSessions === null
                ? "Checking..."
                : hasSessions
                  ? "Yes"
                  : "No"}
            </KeyValuePair>
            <KeyValuePair label="Count">
              {sessionCount ?? "\u2014"}
            </KeyValuePair>
          </KeyValueGrid>

          {recentSessions.length > 0 ? (
            <SurfaceList>
              {recentSessions.map((session) => (
                <SurfaceListItem key={session.key} density="compact">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-slate-200">
                        {session.label || session.displayName || session.key}
                      </p>
                      <p className="truncate font-mono text-[11px] text-slate-500">
                        {session.key}
                      </p>
                    </div>
                    <Badge>{session.kind}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Updated {formatSessionTime(session.updatedAt)}
                  </p>
                </SurfaceListItem>
              ))}
            </SurfaceList>
          ) : (
            <p className="text-sm text-slate-500">
              No orchestrator sessions currently reported.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
