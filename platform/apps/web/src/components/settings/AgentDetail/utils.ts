import type { AgentType } from "../../../../../../contracts/agents";
import type { Agent } from "../../../types/agents";
import { AGENT_KIND_OPTIONS } from "./constants";

export function agentKindLabel(kind: AgentType) {
  if (kind === "manager") return "Manager";
  return (
    AGENT_KIND_OPTIONS.find((option) => option.value === kind)?.label ??
    "Coding"
  );
}

export function runnerKindForAgent(agent: Agent) {
  if (agent.runnerKind) return agent.runnerKind;
  if (agent.agentType === "planning") return "llm_tool_runner";
  if (agent.agentType === "manager") return "llm_tool_runner";
  if (agent.agentType === "custom")
    return agent.customTarget?.backendType ?? "openclaw_ws";
  return "codex";
}

export function runtimeRunnerKindForAgent(
  agent: Agent,
  runtimeProvider: string,
  runtimeProfileRunnerKind: string | null | undefined,
) {
  if (runtimeProvider === "local" && agent.agentType === "coding") {
    return "local_model_coding";
  }
  if (runtimeProvider === "local" && agent.agentType === "planning") {
    return "planner";
  }
  return runtimeProfileRunnerKind ?? runnerKindForAgent(agent);
}
