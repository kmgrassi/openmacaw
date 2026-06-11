import type {
  LocalRuntime,
  LocalRuntimeEvent,
  LocalRuntimeTestDispatchResponse,
} from "../../../api/local-runtime";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { statusToneClass, type StatusTone } from "../../ui/status-tones";
import { formatRelativeTime } from "../../local-runtime/status";

type DoctorCheck = {
  label: string;
  passed: boolean;
  pending?: boolean;
  remediation: string;
};

function checkTone(check: DoctorCheck): StatusTone {
  if (check.pending) return "idle";
  return check.passed ? "success" : "warning";
}

function detailValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function DoctorPanel({
  runtime,
  events,
  eventsLoading,
  testResult,
  testing,
  onRunTest,
}: {
  runtime: LocalRuntime;
  events: LocalRuntimeEvent[];
  eventsLoading: boolean;
  testResult: LocalRuntimeTestDispatchResponse | null;
  testing: boolean;
  onRunTest: () => void;
}) {
  const openAiRunner =
    runtime.runners.find((runner) => runner.kind === "openai_compatible") ??
    null;
  const hasAdvertisedRunner =
    runtime.localExecution.advertisedRunnerKinds.length === 0 ||
    runtime.localExecution.advertisedRunnerKinds.some((kind) =>
      runtime.runners.some(
        (runner) => runner.kind === kind || runner.runnerKind === kind,
      ),
    );
  const configuredModel = openAiRunner?.model ?? "";
  const liveModels = openAiRunner?.models.map((model) => model.model) ?? [];
  const modelMissingError =
    (runtime.lastError ?? runtime.localExecution.lastError)?.includes(
      "not currently advertised",
    ) === true ||
    (runtime.lastError ?? runtime.localExecution.lastError)?.includes(
      "not advertised",
    ) === true;
  const modelPresent =
    !modelMissingError &&
    (!configuredModel ||
      liveModels.length === 0 ||
      liveModels.includes(configuredModel));

  const checks: DoctorCheck[] = [
    {
      label: "Helper connected",
      passed: runtime.status === "online",
      remediation:
        "Helper has not connected: start local-runtime-helper and wait for a fresh heartbeat.",
    },
    {
      label: "Runner advertised",
      passed: hasAdvertisedRunner,
      remediation:
        "Runner missing: confirm the helper config includes this runner and restart the daemon.",
    },
    {
      label: "Model present",
      passed: modelPresent,
      remediation: configuredModel
        ? `Model missing: pull or load ${configuredModel}, then wait for the next model refresh.`
        : "No model is required for this runner.",
    },
    {
      label: "Test dispatch",
      passed: Boolean(testResult?.dispatchSucceeded),
      pending: !testResult,
      remediation:
        testResult?.error?.message ??
        "Run the dispatch test to verify the full local model path.",
    },
  ];

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Doctor panel</h3>
          <p className="mt-1 text-xs text-slate-500">
            Checks the helper, advertised runner, configured model, and a live
            dispatch probe for {runtime.machineDisplayName}.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          loading={testing}
          onClick={onRunTest}
        >
          Run test
        </Button>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {checks.map((check) => {
          const tone = checkTone(check);
          return (
            <div
              key={check.label}
              className={`rounded-md border px-3 py-2 text-xs ${statusToneClass(
                tone,
                "panel",
              )}`}
            >
              <div className="flex items-center gap-2 font-medium">
                <span
                  aria-hidden
                  className={`h-2 w-2 rounded-full ${statusToneClass(
                    tone,
                    "dot",
                  )}`}
                />
                {check.label}
              </div>
              <div className="mt-1 leading-5 opacity-90">
                {check.passed ? "Passing" : check.remediation}
              </div>
            </div>
          );
        })}
      </div>

      {(runtime.lastError || runtime.localExecution.lastError) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {runtime.lastError ?? runtime.localExecution.lastError}
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Event timeline
        </h4>
        {eventsLoading ? (
          <div className="text-xs text-slate-500">Loading events...</div>
        ) : events.length === 0 ? (
          <div className="rounded-md border border-white/5 bg-surface px-3 py-2 text-xs text-slate-500">
            No persisted events yet.
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((event) => (
              <div
                key={event.id}
                className="rounded-md border border-white/5 bg-surface px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-300">
                    {event.kind}
                  </span>
                  <span className="text-slate-500">
                    {formatRelativeTime(event.createdAt)}
                  </span>
                </div>
                {Object.keys(event.detail).length > 0 && (
                  <div className="mt-1 line-clamp-2 text-slate-500">
                    {Object.entries(event.detail)
                      .map(([key, value]) => `${key}: ${detailValue(value)}`)
                      .join(" - ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
