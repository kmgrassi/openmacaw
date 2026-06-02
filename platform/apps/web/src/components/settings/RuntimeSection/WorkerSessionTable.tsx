import type { WorkerBridgeSession } from "../../../api/worker-bridge";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../../ui/KeyValueGrid";
import { SurfaceList, SurfaceListItem } from "../../ui/SurfaceList";
import {
  formatDateTime,
  formatExitStatus,
  formatStatusLabel,
  sessionStatusVariant,
} from "./formatters";

export function WorkerSessionTable({
  error,
  loading,
  onRefresh,
  onStop,
  sessions,
  stoppingSessionId,
}: {
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  onStop: (sessionId: string) => void;
  sessions: WorkerBridgeSession[];
  stoppingSessionId: string | null;
}) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-slate-300">
            Worker bridge sessions
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Sessions started through the runtime launcher on port 4100 via the
            platform API.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          loading={loading}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {!loading && sessions.length === 0 && !error && (
        <p className="text-sm text-slate-500">
          No worker bridge sessions are currently running.
        </p>
      )}

      <SurfaceList gap="md">
        {sessions.map((session) => (
          <SurfaceListItem key={session.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-200">
                    {session.id}
                  </span>
                  <Badge variant={sessionStatusVariant(session.status)}>
                    {formatStatusLabel(session.status)}
                  </Badge>
                  <Badge>{session.kind}</Badge>
                </div>
                <KeyValueGrid className="mt-2 gap-x-3 gap-y-1 text-xs">
                  <KeyValuePair
                    label="CWD"
                    valueClassName="break-all font-mono text-slate-300"
                  >
                    {session.cwd ?? "N/A"}
                  </KeyValuePair>
                  <KeyValuePair
                    label="Command"
                    valueClassName="break-all font-mono text-slate-300"
                  >
                    {session.command}
                  </KeyValuePair>
                  <KeyValuePair label="Started">
                    {formatDateTime(session.startedAt)}
                  </KeyValuePair>
                  <KeyValuePair label="Stopped">
                    {formatDateTime(session.stoppedAt)}
                  </KeyValuePair>
                  <KeyValuePair
                    label="Credentials"
                    valueClassName="font-mono text-slate-300"
                  >
                    {session.credentialKeys.length > 0
                      ? session.credentialKeys.join(", ")
                      : "None"}
                  </KeyValuePair>
                  <KeyValuePair
                    label="Env keys"
                    valueClassName="font-mono text-slate-300"
                  >
                    {session.envKeys.length > 0
                      ? session.envKeys.join(", ")
                      : "None"}
                  </KeyValuePair>
                  <KeyValuePair label="Exit status">
                    {formatExitStatus(session.exitStatus, session.status)}
                  </KeyValuePair>
                </KeyValueGrid>
              </div>

              <Button
                size="sm"
                variant="danger"
                disabled={session.status !== "running"}
                loading={stoppingSessionId === session.id}
                onClick={() => onStop(session.id)}
              >
                Stop
              </Button>
            </div>
          </SurfaceListItem>
        ))}
      </SurfaceList>
    </Card>
  );
}
