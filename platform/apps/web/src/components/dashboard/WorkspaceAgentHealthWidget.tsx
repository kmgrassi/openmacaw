import type { WorkspaceAgentDiagnosticResponse } from "../../../../../contracts/agent-health";
import { useWorkspaceAgentDiagnosticsQuery } from "../../api/queries/runtime-diagnostics";
import { Badge } from "../ui/Badge";
import { LoadingState } from "../ui/LoadingState";

type WorkspaceAgentDiagnostic = Extract<
  WorkspaceAgentDiagnosticResponse,
  { ok: true }
>["agents"][number];

type WorkspaceAgentHealthWidgetProps = {
  workspaceId: string | null | undefined;
};

const ERROR_EXPLANATIONS: Record<string, string> = {
  "runner_spawn_failed.bash_port_dead.codex":
    "Coding Agent can't start because the codex CLI is missing in the container. Contact ops.",
};

function explainError(agent: WorkspaceAgentDiagnostic): string {
  if (!agent.errorCode) return "Runtime reported an agent startup failure.";
  return (
    ERROR_EXPLANATIONS[agent.errorCode] ??
    "Runtime reported an unmapped agent startup failure."
  );
}

function formatErrorDetails(details: unknown): string {
  if (typeof details === "string") return details;
  if (details == null) return "";
  try {
    return JSON.stringify(details);
  } catch {
    return "Additional diagnostic details are unavailable.";
  }
}

function statusVariant(status: WorkspaceAgentDiagnostic["status"]) {
  if (status === "ok") return "success";
  if (status === "error") return "error";
  return "warning";
}

function statusIcon(status: WorkspaceAgentDiagnostic["status"]) {
  if (status === "ok") return "✓";
  if (status === "error") return "×";
  return "…";
}

function statusLabel(status: WorkspaceAgentDiagnostic["status"]) {
  if (status === "ok") return "Healthy";
  if (status === "error") return "Needs attention";
  return "Pending";
}

export function WorkspaceAgentHealthWidget({
  workspaceId,
}: WorkspaceAgentHealthWidgetProps) {
  const diagnosticsQuery = useWorkspaceAgentDiagnosticsQuery({ workspaceId });

  if (!workspaceId) return null;

  const diagnostics = diagnosticsQuery.data;

  if (diagnostics?.ok === false) {
    return (
      <section className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Orchestrator unreachable</h2>
            <p className="mt-1 text-amber-800">{diagnostics.details}</p>
          </div>
          <Badge variant="warning">{diagnostics.reason}</Badge>
        </div>
      </section>
    );
  }

  if (diagnosticsQuery.isLoading && !diagnostics) {
    return (
      <section className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
        <LoadingState label="Checking workspace agents..." />
      </section>
    );
  }

  if (diagnosticsQuery.error && !diagnostics) {
    return (
      <section className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 shadow-sm">
        <h2 className="text-sm font-semibold">Agent health unavailable</h2>
        <p className="mt-1 text-red-800">
          {(diagnosticsQuery.error as Error).message}
        </p>
      </section>
    );
  }

  if (!diagnostics?.ok) return null;

  const problemCount = diagnostics.agents.filter(
    (agent) => agent.status === "error",
  ).length;

  return (
    <section className="rounded-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Workspace agent health
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {problemCount > 0
              ? `${problemCount} agent${problemCount === 1 ? "" : "s"} need attention.`
              : "All workspace agents are ready."}
          </p>
        </div>
        <Badge variant={problemCount > 0 ? "error" : "success"}>
          {problemCount > 0 ? "attention" : "healthy"}
        </Badge>
      </div>

      <div className="mt-3 divide-y divide-slate-100">
        {diagnostics.agents.length === 0 ? (
          <div className="py-2 text-sm text-slate-500">
            No agents reported for this workspace.
          </div>
        ) : (
          diagnostics.agents.map((agent) => (
            <div
              key={agent.agentId}
              className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={
                      agent.status === "ok"
                        ? "text-green-600"
                        : agent.status === "error"
                          ? "text-red-600"
                          : "text-amber-600"
                    }
                  >
                    {statusIcon(agent.status)}
                  </span>
                  <span className="truncate text-sm font-medium text-slate-900">
                    {agent.agentId}
                  </span>
                  <Badge>{agent.runnerKind}</Badge>
                </div>
                {agent.status === "error" && (
                  <p className="mt-1 text-sm text-red-700">
                    {agent.errorCode ? `${agent.errorCode}: ` : ""}
                    {explainError(agent)}
                  </p>
                )}
                {agent.errorDetails !== undefined && (
                  <p className="mt-1 text-xs text-slate-500">
                    {formatErrorDetails(agent.errorDetails)}
                  </p>
                )}
              </div>
              <Badge variant={statusVariant(agent.status)}>
                {statusLabel(agent.status)}
              </Badge>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
