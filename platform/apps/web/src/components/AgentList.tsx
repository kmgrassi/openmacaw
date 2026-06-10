import type { Agent } from "../hooks/useAgents";
import { useLocalRuntimesQuery } from "../hooks/useServerStateQueries";
import { cn } from "../lib/cn";
import { formatAgentMetadata } from "../lib/agent-metadata";
import { LocalRuntimeStatusChip } from "./local-runtime/LocalRuntimeStatusChip";
import { statusToneClass, statusToneForValue } from "./ui/status-tones";

export type AgentActivationState = {
  phase: "idle" | "activating" | "ready" | "error";
  message: string | null;
};

type Props = {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (agent: Agent) => void;
  activationByAgentId?: Record<string, AgentActivationState | undefined>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

export function AgentList({
  agents,
  selectedId,
  onSelect,
  activationByAgentId,
  loading,
  error,
  onRetry,
}: Props) {
  const workspaceId = agents.find((agent) => agent.workspaceId)?.workspaceId;
  const { data: localRuntimes } = useLocalRuntimesQuery(workspaceId);

  if (loading) {
    return (
      <div className="px-3 py-4 text-xs text-slate-500">Loading agents...</div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2 px-3 py-4 text-xs">
        <div className="text-amber-300">Could not load agents.</div>
        <div className="text-slate-500">{error}</div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="rounded border border-border px-2 py-1 text-slate-300 hover:bg-surface-overlay/50"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-slate-500">No agents found.</div>
    );
  }

  return (
    <div className="space-y-1 px-2 py-2">
      {agents.map((agent) =>
        (() => {
          const activation = activationByAgentId?.[agent.id];
          const metadata = formatAgentMetadata(agent);
          const activationTone = statusToneForValue(activation?.phase, "idle");
          const isSelected = selectedId === agent.id;

          return (
            <button
              key={agent.id}
              onClick={() => onSelect(agent)}
              title={metadata ? `${agent.name} (${metadata})` : agent.name}
              className={cn(
                "relative flex w-full gap-2.5 overflow-hidden rounded-lg py-2 pl-3.5 pr-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                isSelected
                  ? "bg-surface-raised text-slate-100 shadow-[inset_0_0_0_1px_rgba(96,165,250,0.18)]"
                  : "text-slate-300 hover:bg-surface-overlay/50",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-full transition-colors",
                  isSelected ? "bg-blue-400" : "bg-transparent",
                )}
              />
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  statusToneClass(activationTone, "dot"),
                )}
              />
              <span className="min-w-0">
                <span
                  className={cn(
                    "block truncate text-sm leading-5",
                    isSelected ? "font-semibold" : "font-medium",
                  )}
                >
                  {agent.name}
                </span>
                {metadata && (
                  <span
                    className={cn(
                      "mt-0.5 block truncate text-xs leading-4",
                      isSelected ? "text-slate-400" : "text-slate-500",
                    )}
                  >
                    {metadata}
                  </span>
                )}
                <LocalRuntimeStatusChip
                  agentId={agent.id}
                  runtimes={localRuntimes?.runtimes ?? []}
                  className="mt-1"
                  linkToSettings={false}
                />
                {activation?.message && (
                  <span
                    className={cn(
                      "mt-0.5 block truncate text-xs",
                      statusToneClass(activationTone, "text"),
                    )}
                  >
                    {activation.message}
                  </span>
                )}
              </span>
            </button>
          );
        })(),
      )}
    </div>
  );
}
