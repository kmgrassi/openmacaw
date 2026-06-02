import { Link } from "react-router-dom";

import type { Agent } from "../../../types/agents";
import { Badge } from "../../ui/Badge";
import { ButtonLink } from "../../ui/ButtonLink";
import { agentKindLabel } from "./utils";

type AgentDetailHeaderProps = {
  agent: Agent;
};

export function AgentDetailHeader({ agent }: AgentDetailHeaderProps) {
  return (
    <div className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <nav
          className="mb-3 flex flex-wrap items-center gap-2 text-sm"
          aria-label="Agent settings breadcrumb"
        >
          <Link
            to="/settings/agents"
            className="font-medium text-slate-500 transition-colors hover:text-slate-300"
          >
            Agents
          </Link>
          <span className="text-slate-700">/</span>
          <span className="max-w-72 truncate font-medium text-slate-300">
            {agent.name}
          </span>
          <span className="text-slate-700">/</span>
          <ButtonLink
            to={`/dashboard/${agent.id}`}
            size="sm"
            className="border-blue-500/35 bg-blue-500/10 px-3 py-1.5 text-sm font-semibold text-blue-100 hover:border-blue-400/60 hover:bg-blue-500/20"
          >
            Back to Chat
          </ButtonLink>
        </nav>
        <h3 className="text-base font-semibold text-slate-200">{agent.name}</h3>
        <p className="mt-0.5 font-mono text-xs text-slate-500">{agent.id}</p>
      </div>
      <div className="flex items-center gap-2">
        <Badge>{agentKindLabel(agent.agentType)}</Badge>
        {agent.model && <Badge>{agent.model}</Badge>}
        {agent.hasCredentials ? (
          <Badge variant="success">credentials set</Badge>
        ) : (
          <Badge variant="warning">no credentials</Badge>
        )}
      </div>
    </div>
  );
}
