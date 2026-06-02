import type { Agent } from "../../types/agents";

const CONFIGURATION_LABELS: Record<string, string> = {
  agent: "agent record",
  credential: "API key",
  model: "model",
  gateway_config: "runtime config",
  runner: "runner",
};

export function formatAgentType(type: string) {
  const normalized = type.trim().replace(/[_-]+/g, " ");
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

export function formatAgentMetadata(agent: Pick<Agent, "agentType" | "model">) {
  return [formatAgentType(agent.agentType), agent.model]
    .filter(Boolean)
    .join(" · ");
}

export function formatMissingConfiguration(missing: string[]) {
  if (missing.length === 0) return null;
  const labels = missing.map(
    (item) => CONFIGURATION_LABELS[item] ?? item.replace(/_/g, " "),
  );
  return `${labels.join(", ")} required`;
}

export function agentMissingConfiguration(
  agent: Pick<Agent, "configurationStatus" | "hasCredentials" | "model">,
) {
  if (agent.configurationStatus) {
    return agent.configurationStatus.configured
      ? []
      : agent.configurationStatus.missing;
  }

  const missing: string[] = [];
  if (!agent.hasCredentials) missing.push("credential");
  if (!agent.model) missing.push("model");
  return missing;
}
