import { NavLink } from "react-router-dom";

import type { LocalRuntime } from "../../api/local-runtime";
import { useLocalRuntimesQuery } from "../../hooks/useServerStateQueries";
import { cn } from "../../lib/cn";
import type { Agent } from "../../types/agents";
import { LocalRuntimeStatusChip } from "../local-runtime/LocalRuntimeStatusChip";
import { statusToneClass } from "../ui/status-tones";
import {
  agentMissingConfiguration,
  formatAgentMetadata,
  formatMissingConfiguration,
} from "./agent-metadata";

type AgentNavItemProps = {
  agent: Agent;
  collapsed: boolean;
  inAgentSettings: boolean;
  onNavigate: () => void;
};

export function AgentNavItem({
  agent,
  collapsed,
  inAgentSettings,
  onNavigate,
}: AgentNavItemProps) {
  const { data: localRuntimes } = useLocalRuntimesQuery(agent.workspaceId);
  const metadata = formatAgentMetadata(agent);
  const configurationWarning = formatMissingConfiguration(
    agentMissingConfiguration(agent),
  );
  const titleParts = [
    metadata ? `${agent.name} (${metadata})` : agent.name,
    configurationWarning,
  ].filter(Boolean);

  return (
    <NavLink
      to={
        inAgentSettings
          ? `/settings/agents/${agent.id}`
          : `/dashboard/${agent.id}`
      }
      onClick={onNavigate}
      title={titleParts.join(" - ")}
      className={({ isActive }) =>
        cn(
          "group relative flex min-h-9 rounded-md py-1.5 pr-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
          collapsed
            ? "items-center justify-center pl-2.5"
            : "items-start gap-2.5 pl-3.5",
          isActive
            ? "bg-surface-raised text-slate-100 shadow-[inset_0_0_0_1px_rgba(96,165,250,0.18)]"
            : "text-slate-400 hover:bg-surface-raised hover:text-slate-200",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden
            className={cn(
              "absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-full transition-colors",
              isActive ? "bg-blue-400" : "bg-transparent",
            )}
          />
          {collapsed ? (
            <CollapsedAgentContent
              agent={agent}
              configurationWarning={configurationWarning}
              isActive={isActive}
            />
          ) : (
            <ExpandedAgentContent
              agent={agent}
              metadata={metadata}
              configurationWarning={configurationWarning}
              isActive={isActive}
              runtimes={localRuntimes?.runtimes ?? []}
            />
          )}
        </>
      )}
    </NavLink>
  );
}

function CollapsedAgentContent({
  agent,
  configurationWarning,
  isActive,
}: {
  agent: Agent;
  configurationWarning: string | null;
  isActive: boolean;
}) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md text-xs transition-colors",
          isActive
            ? "bg-blue-500/15 font-semibold text-slate-50"
            : "text-slate-400",
        )}
      >
        {agent.name.slice(0, 1).toUpperCase()}
      </span>
      {configurationWarning && (
        <span
          aria-hidden
          className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full shadow-[0_0_0_2px_rgba(15,23,42,0.95)] ${statusToneClass(
            "warning",
            "dot",
          )}`}
        />
      )}
    </>
  );
}

function ExpandedAgentContent({
  agent,
  metadata,
  configurationWarning,
  isActive,
  runtimes,
}: {
  agent: Agent;
  metadata: string;
  configurationWarning: string | null;
  isActive: boolean;
  runtimes: LocalRuntime[];
}) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
          isActive
            ? agent.hasCredentials
              ? statusToneClass("success", "dot")
              : statusToneClass("warning", "dot")
            : statusToneClass("idle", "dot"),
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm leading-5",
            isActive
              ? "font-semibold text-slate-50"
              : "font-medium text-slate-500 group-hover:text-slate-300",
          )}
        >
          {agent.name}
        </span>
        {metadata && (
          <span
            className={cn(
              "mt-0.5 block truncate text-xs leading-4 transition-opacity",
              isActive
                ? "text-slate-400"
                : "text-slate-600 opacity-0 group-hover:opacity-100",
            )}
          >
            {metadata}
          </span>
        )}
        <LocalRuntimeStatusChip
          agentId={agent.id}
          runtimes={runtimes}
          className={cn(
            "mt-1 max-w-full",
            isActive
              ? ""
              : "opacity-0 transition-opacity group-hover:opacity-100",
          )}
          linkToSettings={false}
        />
      </span>
      {configurationWarning && (
        <span className="relative mt-0.5 shrink-0">
          <span
            aria-label={`Agent configuration warning: ${configurationWarning}`}
            title={configurationWarning}
            className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold leading-none ${statusToneClass(
              "warning",
              "panel",
            )}`}
          >
            !
          </span>
          <span className="pointer-events-none absolute right-0 top-6 z-20 hidden w-56 rounded-md border border-amber-400/30 bg-slate-950 px-2.5 py-2 text-xs normal-case leading-4 text-amber-100 shadow-lg group-hover:block">
            {configurationWarning}
          </span>
        </span>
      )}
    </>
  );
}
