import type {
  LocalRuntime,
  LocalModelProbeResponse,
} from "../../../api/local-runtime";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { formatLastSeen } from "./utils";

export function BoundSummary({
  runtime,
  runnerProbes,
  probingRunnerId,
  resetting,
  removing,
  onProbeRunner,
  onResetToken,
  onDisconnect,
}: {
  runtime: LocalRuntime;
  runnerProbes: Record<string, LocalModelProbeResponse | null>;
  probingRunnerId: string | null;
  resetting: boolean;
  removing: boolean;
  /** Per-runner probe trigger. Null when the runner has no probe support (e.g. openclaw). */
  onProbeRunner: (runnerId: string) => void;
  onResetToken: () => void;
  onDisconnect: () => void;
}) {
  const boundRunners = runtime.runners.filter(
    (runner) => runner.agents.length > 0,
  );

  return (
    <Card className="space-y-4 border-green-600/30 bg-green-950/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-green-200">
            Local runtime is bound
          </h3>
          <div className="mt-1 space-y-1 text-xs text-green-300/80">
            {boundRunners.map((runner) => (
              <div key={runner.id}>
                <span className="font-medium">{runner.kind}</span>:{" "}
                {runner.agents.map((agent) => agent.agentName).join(", ")}
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={resetting}
            onClick={onResetToken}
          >
            Reset token
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={removing}
            onClick={onDisconnect}
          >
            Disconnect this machine
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        {runtime.runners.map((runner) => {
          const probe = runnerProbes[runner.id];
          const canProbe = runner.kind === "openai_compatible";
          return (
            <div
              key={runner.id}
              className="rounded-md border border-white/5 bg-surface px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-slate-300">
                  <span className="font-medium">{runner.kind}</span>
                  <span className="text-slate-500"> — {runner.endpoint}</span>
                </div>
                {canProbe && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={probingRunnerId === runner.id}
                    onClick={() => onProbeRunner(runner.id)}
                  >
                    Test connection
                  </Button>
                )}
              </div>
              {probe && canProbe && (
                <div
                  className={`mt-2 rounded-md border px-2 py-1 ${
                    probe.reachable && probe.modelFound
                      ? "border-green-600/30 bg-green-950/20 text-green-200"
                      : "border-amber-600/30 bg-amber-950/20 text-amber-200"
                  }`}
                >
                  {probe.reachable && probe.modelFound
                    ? `Connection OK at ${formatLastSeen(probe.checkedAt)}`
                    : (probe.error ??
                      "Connection test did not find the model.")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
