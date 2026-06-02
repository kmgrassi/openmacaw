import type {
  ExecutionProfileMissingRequirement,
  ExecutionProfileResolution,
  RuntimeExecutionTargetKind,
} from "../../../../../../contracts/execution-profile.js";
import type {
  AgentConfigurationChecklist,
  AgentConfigurationChecklistItem,
  AgentConfigurationChecklistStep,
  DefaultAgentMissingRequirement,
  SetupRequirementStatus,
} from "../../../../../../contracts/setup.js";
import type { AgentRow, GatewayConfigRow } from "../types.js";

function hasPrimaryModel(modelSettings: unknown) {
  if (!modelSettings || typeof modelSettings !== "object" || Array.isArray(modelSettings)) return false;
  const primary = (modelSettings as Record<string, unknown>).primary;
  return typeof primary === "string" && primary.trim().length > 0;
}

function hasGatewayRunner(configJson: unknown) {
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) return false;
  const runners = (configJson as Record<string, unknown>).runners;
  if (Array.isArray(runners)) return runners.length > 0;
  if (runners && typeof runners === "object") {
    return Object.values(runners as Record<string, unknown>).some(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
    );
  }
  return false;
}

export function buildRequirementStatus(
  agent: AgentRow,
  gatewayConfig: GatewayConfigRow | null,
  credentialCount: number,
): SetupRequirementStatus {
  const missing: SetupRequirementStatus["missing"] = [];
  if (credentialCount === 0) missing.push("credential");
  if (!hasPrimaryModel(agent.model_settings)) missing.push("model");
  if (!gatewayConfig) {
    missing.push("gateway_config", "runner");
  } else if (!hasGatewayRunner(gatewayConfig.config_json)) {
    missing.push("runner");
  }

  return {
    configured: missing.length === 0,
    missing,
  };
}

function toSetupMissingRequirement(missing: ExecutionProfileMissingRequirement): DefaultAgentMissingRequirement | null {
  if (missing === "provider") return "model";
  if (missing === "route") return "runner";
  if (
    missing === "agent" ||
    missing === "credential" ||
    missing === "model" ||
    missing === "gateway_config" ||
    missing === "runner"
  ) {
    return missing;
  }
  return null;
}

function hasMissing(resolution: ExecutionProfileResolution, requirement: ExecutionProfileMissingRequirement): boolean {
  return resolution.missing.includes(requirement);
}

function agentSettingsUrl(agentId: string): string {
  return `/settings/agents/${agentId}`;
}

function checklistItem(input: {
  step: AgentConfigurationChecklistStep;
  failed: boolean;
  passLabel: string;
  failLabel: string;
  action?: AgentConfigurationChecklistItem["action"];
  actionUrl?: string;
}): AgentConfigurationChecklistItem {
  const item: AgentConfigurationChecklistItem = {
    step: input.step,
    status: input.failed ? "fail" : "pass",
    label: input.failed ? input.failLabel : input.passLabel,
  };

  if (input.failed && input.action) {
    item.action = input.action;
  }
  if (input.failed && input.actionUrl) {
    item.actionUrl = input.actionUrl;
  }

  return item;
}

export function buildConfigurationChecklist(
  resolution: ExecutionProfileResolution,
  agentId: string,
): AgentConfigurationChecklist {
  const settingsUrl = agentSettingsUrl(agentId);
  const agentMissing = hasMissing(resolution, "agent") || !resolution.agent;
  const providerMissing = hasMissing(resolution, "provider");
  const modelMissing = hasMissing(resolution, "model");
  const credentialMissing = hasMissing(resolution, "credential");
  const routeMissing = !resolution.source.routingRuleId;
  const gatewayConfigMissing = hasMissing(resolution, "gateway_config");
  const runnerMissing = hasMissing(resolution, "runner");
  const provider = resolution.profile?.provider ?? null;
  const model = resolution.profile?.model ?? null;
  const runnerKind = resolution.profile?.runnerKind ?? null;

  const checklist: AgentConfigurationChecklistItem[] = [
    checklistItem({
      step: "agent_exists",
      failed: agentMissing,
      passLabel: "Agent created",
      failLabel: "Agent not found",
    }),
    checklistItem({
      step: "routing_rule",
      failed: routeMissing,
      passLabel: "Routing rule matched",
      failLabel: "Routing rule required",
      action: "configure_routing",
      actionUrl: settingsUrl,
    }),
    checklistItem({
      step: "provider_configured",
      failed: providerMissing,
      passLabel: provider ? `Provider: ${provider}` : "Provider configured",
      failLabel: "Provider required",
      action: "select_model",
      actionUrl: settingsUrl,
    }),
    checklistItem({
      step: "model_selected",
      failed: modelMissing,
      passLabel: model ? `Model: ${model}` : "Model selected",
      failLabel: "Model required",
      action: "select_model",
      actionUrl: settingsUrl,
    }),
    checklistItem({
      step: "credential_configured",
      failed: credentialMissing,
      passLabel: "API key configured",
      failLabel: "API key required",
      action: "add_credential",
      actionUrl: settingsUrl,
    }),
    checklistItem({
      step: "gateway_config",
      failed: gatewayConfigMissing,
      passLabel: "Gateway config available",
      failLabel: "Gateway config missing",
      action: "configure_runtime",
      actionUrl: settingsUrl,
    }),
    checklistItem({
      step: "runner_configured",
      failed: runnerMissing,
      passLabel: runnerKind ? `Runtime: ${runnerKind}` : "Runtime configured",
      failLabel: "Runtime not configured",
      action: "configure_runtime",
      actionUrl: settingsUrl,
    }),
  ];

  return {
    configured: checklist.every((item) => item.status === "pass"),
    checklist,
  };
}

export function buildRequirementStatusFromResolution(
  resolution: ExecutionProfileResolution,
  options: {
    includeChecklist?: boolean;
    agentId?: string;
    localCodingExecutionTargetKind?: RuntimeExecutionTargetKind | null;
  } = {},
): SetupRequirementStatus {
  const missingSet = new Set(
    resolution.missing
      .map(toSetupMissingRequirement)
      .filter((value): value is DefaultAgentMissingRequirement => value !== null),
  );
  const missingOrder: DefaultAgentMissingRequirement[] = ["agent", "credential", "model", "gateway_config", "runner"];
  const missing = missingOrder.filter((requirement) => missingSet.has(requirement));

  return {
    configured: missing.length === 0,
    missing,
    ...(options.includeChecklist && options.agentId
      ? { checklist: buildConfigurationChecklist(resolution, options.agentId).checklist }
      : {}),
    executionProfile: resolution,
    ...(options.localCodingExecutionTargetKind !== undefined
      ? { localCodingExecutionTargetKind: options.localCodingExecutionTargetKind }
      : {}),
  };
}
