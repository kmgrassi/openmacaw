import type { Agent } from "../types/agents";
import { formatDisplayLabel, normalizeDisplayLabel } from "./display-labels";

const CONFIGURATION_LABELS: Record<string, string> = {
  agent: "agent record",
  credential: "API key",
  model: "model",
  gateway_config: "runtime config",
  runner: "runner",
};

export function formatAgentType(type: string) {
  return formatDisplayLabel(type, {
    fallback: "",
    lowercaseRemainder: true,
  });
}

export function formatAgentMetadata(agent: Pick<Agent, "agentType" | "model">) {
  return [formatAgentType(agent.agentType), agent.model]
    .filter(Boolean)
    .join(" · ");
}

export function formatMissingConfiguration(missing: string[]) {
  if (missing.length === 0) return null;
  const labels = missing.map(
    (item) => CONFIGURATION_LABELS[item] ?? normalizeDisplayLabel(item),
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
