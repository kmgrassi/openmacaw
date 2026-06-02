import { ModelSettingsSchema, type AgentType, type ModelSettings } from "../../../../../../contracts/agents.js";
import type { DefaultAgentRole, SetupRequest } from "../../../../../../contracts/setup.js";

export function buildModelSettings(model: string): ModelSettings {
  return ModelSettingsSchema.parse({
    primary: model,
  });
}

export function agentType(input: Pick<SetupRequest, "agentType">, fallback: AgentType = "coding"): AgentType {
  return input.agentType ?? fallback;
}

export function defaultAgentName(role: DefaultAgentRole) {
  return role === "planning" ? "Planning Agent" : "Coding Agent";
}

export function managerAgentName() {
  return "Manager Agent";
}
