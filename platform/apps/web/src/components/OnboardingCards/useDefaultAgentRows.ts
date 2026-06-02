import { useMemo } from "react";

import { useAuthStore } from "../../stores/auth";

export type DefaultAgentKey = "planning" | "coding" | "manager";

export type DefaultAgentRow = {
  role: string;
  key: DefaultAgentKey;
  description: string;
  agentId: string | null;
};

export const DEFAULT_AGENT_DESCRIPTIONS: Array<
  Omit<DefaultAgentRow, "agentId">
> = [
  {
    role: "Planning agent",
    key: "planning",
    description:
      "This is the agent you talk to. It plans work and hands coding tasks off to your coding agent.",
  },
  {
    role: "Coding agent",
    key: "coding",
    description:
      "Works in the background. The planning agent sends it coding tasks; you rarely need to message it directly.",
  },
  {
    role: "Manager agent",
    key: "manager",
    description:
      "Works in the background to coordinate work across your agents.",
  },
];

export function useDefaultAgentRows(): DefaultAgentRow[] {
  const { defaultAgents, managerAgent } = useAuthStore();
  return useMemo(
    () =>
      DEFAULT_AGENT_DESCRIPTIONS.map((agent) => ({
        ...agent,
        agentId:
          agent.key === "manager"
            ? managerAgent.agentId
            : defaultAgents[agent.key].agentId,
      })),
    [defaultAgents, managerAgent.agentId],
  );
}
