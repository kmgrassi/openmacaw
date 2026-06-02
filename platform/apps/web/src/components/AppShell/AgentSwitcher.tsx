import type { Agent } from "../../types/agents";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { AgentNavItem } from "./AgentNavItem";
import { NavSection } from "./NavSection";

type AgentSwitcherProps = {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  showLabels: boolean;
  agentsOpen: boolean;
  inAgentSettings: boolean;
  onToggleAgents: () => void;
  onCreateAgent: () => void;
  onNavigate: () => void;
  onRetry: () => void;
};

export function AgentSwitcher({
  agents,
  loading,
  error,
  collapsed,
  showLabels,
  agentsOpen,
  inAgentSettings,
  onToggleAgents,
  onCreateAgent,
  onNavigate,
  onRetry,
}: AgentSwitcherProps) {
  return (
    <NavSection
      label="Agents"
      collapsed={collapsed}
      open={agentsOpen}
      onToggle={onToggleAgents}
      action={
        <IconButton
          onClick={onCreateAgent}
          className="text-lg text-slate-500"
          aria-label="Create new agent"
          title="Create new agent"
        >
          +
        </IconButton>
      }
    >
      {loading && (
        <div className="px-2 py-2 text-xs text-slate-500">
          Loading agents...
        </div>
      )}
      {error && (
        <div className="space-y-2 px-2 py-2 text-xs">
          <div className="text-amber-300">Could not load agents.</div>
          {showLabels && <div className="text-slate-500">{error}</div>}
          <Button type="button" onClick={onRetry} variant="secondary" size="sm">
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && agents.length === 0 && (
        <div className="px-2 py-2 text-xs text-slate-500">No agents found.</div>
      )}
      {agents.map((agent) => (
        <AgentNavItem
          key={agent.id}
          agent={agent}
          collapsed={collapsed}
          inAgentSettings={inAgentSettings}
          onNavigate={onNavigate}
        />
      ))}
    </NavSection>
  );
}
