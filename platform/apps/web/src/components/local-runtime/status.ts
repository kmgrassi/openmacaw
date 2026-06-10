import type { LocalRuntime } from "../../api/local-runtime";

export type LocalRuntimeBindingStatus =
  | {
      kind: "none";
      label: string;
      detail: string;
      tone: "neutral";
    }
  | {
      kind: "online" | "offline" | "model_missing" | "degraded";
      label: string;
      detail: string;
      tone: "success" | "error" | "warning";
      runtime: LocalRuntime;
      runnerId: string;
    };

export function localRuntimeBindingStatusForAgent(
  agentId: string,
  runtimes: LocalRuntime[],
): LocalRuntimeBindingStatus {
  for (const runtime of runtimes) {
    for (const runner of runtime.runners) {
      if (!runner.agents.some((agent) => agent.agentId === agentId)) continue;

      const modelLabel = runner.model || runner.kind;
      const machineLabel = runtime.machineDisplayName;
      const liveModels = runner.liveModels.map((model) => model.model);
      const lastError = runtime.lastError ?? runtime.localExecution.lastError;
      const modelMissing =
        (runner.model.length > 0 &&
          liveModels.length > 0 &&
          !liveModels.includes(runner.model)) ||
        lastError?.includes("not currently advertised") === true;

      if (runtime.status === "offline") {
        return {
          kind: "offline",
          label: `offline - last seen ${formatRelativeTime(runtime.localExecution.lastSeenAt)}`,
          detail: lastError ?? "Helper has not sent a recent heartbeat.",
          tone: "error",
          runtime,
          runnerId: runner.id,
        };
      }

      if (modelMissing) {
        return {
          kind: "model_missing",
          label: "model no longer advertised by helper",
          detail: `${modelLabel} is not in the latest advertised model list from ${machineLabel}.`,
          tone: "warning",
          runtime,
          runnerId: runner.id,
        };
      }

      if (runtime.status === "degraded" || runtime.lastError) {
        return {
          kind: "degraded",
          label: `${modelLabel} @ ${machineLabel}`,
          detail: lastError ?? "Helper is connected but reported a problem.",
          tone: "warning",
          runtime,
          runnerId: runner.id,
        };
      }

      return {
        kind: "online",
        label: `${modelLabel} @ ${machineLabel}`,
        detail: "Helper connected and model binding is current.",
        tone: "success",
        runtime,
        runnerId: runner.id,
      };
    }
  }

  return {
    kind: "none",
    label: "No local model binding",
    detail: "This agent is not assigned to a local runtime.",
    tone: "neutral",
  };
}

export function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "unknown";
  const elapsedMs = Math.max(Date.now() - timestamp, 0);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsedMs < minute) return "just now";
  if (elapsedMs < hour) return `${Math.round(elapsedMs / minute)} min ago`;
  if (elapsedMs < day) return `${Math.round(elapsedMs / hour)} h ago`;
  return `${Math.round(elapsedMs / day)} d ago`;
}
