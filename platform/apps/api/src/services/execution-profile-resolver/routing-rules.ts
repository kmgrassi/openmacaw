import { deriveProviderFromModel, extractPrimaryModel } from "../../../../../contracts/agent-helpers.js";
import { ModelSettingsSchema } from "../../../../../contracts/agents.js";
import type { AgentRole, ExecutionProfileFallback } from "../../../../../contracts/execution-profile.js";
import { RegisteredProviderSchema, modelTier } from "../../../../../contracts/model-tiers.js";
import { normalizeRunnerKind } from "../../../../../contracts/runner-kinds.js";
import { ApiRouteError } from "../../http.js";
import { buildResolution } from "./build-resolution.js";
import { resolveCredentialAlias } from "./queries.js";
import type { AgentProfileRow, RoutingRuleFallbackRow, RoutingRuleMatchRow, RoutingRuleRow } from "./types.js";

export function matchValue(
  input: { agent: Pick<AgentProfileRow, "id">; role: AgentRole; intent: string | null; intentKey: string | null },
  match: RoutingRuleMatchRow,
) {
  const kind = match.kind.trim().toLowerCase();
  const key = match.key?.trim() || null;
  const value = match.value.trim();
  if (isRoutingMetadataMatch(match)) return true;
  if (kind === "agent_id") return (!key || key === "id" || key === "agent_id") && value === input.agent.id;
  if (kind === "agent_type" || kind === "role") return (!key || key === "type") && value === input.role;
  if (kind === "intent") {
    if (key && key !== input.intentKey) return false;
    return Boolean(input.intent) && value === input.intent;
  }
  return false;
}

export function isRoutingMetadataMatch(match: Pick<RoutingRuleMatchRow, "kind">) {
  const kind = match.kind.trim().toLowerCase();
  return (
    kind === "local_endpoint" ||
    kind === "local_workspace_root" ||
    kind === "local_machine" ||
    kind === "local_model_capability"
  );
}

export function selectRoutingRule(input: {
  agent: AgentProfileRow;
  role: AgentRole;
  intent: string | null;
  intentKey: string | null;
  rules: RoutingRuleRow[];
  matches: RoutingRuleMatchRow[];
}) {
  const matchesByRule = new Map<string, RoutingRuleMatchRow[]>();
  for (const match of input.matches) {
    const existing = matchesByRule.get(match.rule_id) ?? [];
    existing.push(match);
    matchesByRule.set(match.rule_id, existing);
  }

  const matchingRules = input.rules
    .map((rule, index) => {
      const ruleMatches = matchesByRule.get(rule.id) ?? [];
      const predicateMatches = ruleMatches.filter((match) => !isRoutingMetadataMatch(match));
      const matched = ruleMatches.every((match) => matchValue(input, match));
      return { index, matched, rule, predicateMatches };
    })
    .filter((candidate) => candidate.matched);

  matchingRules.sort((left, right) => {
    const priorityDelta = right.rule.priority - left.rule.priority;
    if (priorityDelta !== 0) return priorityDelta;

    const specificityDelta = right.predicateMatches.length - left.predicateMatches.length;
    if (specificityDelta !== 0) return specificityDelta;

    const localCodingDelta =
      Number(right.rule.runner_kind === "local_model_coding") - Number(left.rule.runner_kind === "local_model_coding");
    if (localCodingDelta !== 0) return localCodingDelta;

    return left.index - right.index;
  });

  return matchingRules[0]?.rule;
}

async function buildRuleResolution(input: {
  agent: AgentProfileRow;
  role: AgentRole;
  rule: RoutingRuleRow;
  matches: RoutingRuleMatchRow[];
  fallbacks: RoutingRuleFallbackRow[];
  accessToken?: string;
}) {
  const credentialId =
    input.rule.credential_id ??
    (input.rule.credential_alias
      ? await resolveCredentialAlias(input.agent.workspace_id, input.rule.credential_alias, input.accessToken)
      : null);
  const model = input.rule.model?.trim() || extractPrimaryModel(ModelSettingsSchema.parse(input.agent.model_settings));
  const metadata = routingMetadata(input.matches);
  const fallbacks = await buildFallbacks({
    workspaceId: input.agent.workspace_id,
    rows: input.fallbacks,
    accessToken: input.accessToken,
  });
  return buildResolution({
    agent: input.agent,
    role: input.role,
    runnerKind: normalizeRunnerKind(input.rule.runner_kind),
    provider: input.rule.provider?.trim() || deriveProviderFromModel(model),
    model,
    credentialRef: credentialId ? { type: "credential_id", value: credentialId } : null,
    hasCredential: Boolean(credentialId),
    routingRuleId: input.rule.id,
    credentialAlias: input.rule.credential_alias,
    fallbackUsed: false,
    legacyGatewayConfigUsed: false,
    fallbacks,
    modelTierFloor: input.rule.model_tier_floor ?? "any",
    adapterConfig: metadata.adapterConfig,
    sourceMetadata: metadata.sourceMetadata,
  });
}

async function buildFallbacks(input: {
  workspaceId: string;
  rows: RoutingRuleFallbackRow[];
  accessToken?: string;
}): Promise<ExecutionProfileFallback[]> {
  const fallbacks: ExecutionProfileFallback[] = [];

  for (const row of input.rows) {
    const providerResult = RegisteredProviderSchema.safeParse(row.provider);
    const tier = providerResult.success ? modelTier(providerResult.data, row.model) : null;
    if (!providerResult.success || !tier) {
      throw new ApiRouteError(
        422,
        "unknown_model_in_fallback_chain",
        "Routing rule fallback references a provider/model pair that is not classified in MODEL_TIER_REGISTRY",
        {
          routingRuleId: row.routing_rule_id,
          position: row.position,
          provider: row.provider,
          model: row.model,
        },
      );
    }

    const credentialId =
      row.credential_id ??
      (row.credential_alias
        ? await resolveCredentialAlias(input.workspaceId, row.credential_alias, input.accessToken)
        : null);
    fallbacks.push({
      provider: providerResult.data,
      model: row.model,
      ...(credentialId ? { credentialRef: { type: "credential_id" as const, value: credentialId } } : {}),
    });
  }

  return fallbacks;
}

function routingMetadata(matches: RoutingRuleMatchRow[]) {
  const adapterConfig: Record<string, unknown> = {};
  const sourceMetadata: Record<string, unknown> = {};

  for (const match of matches) {
    const kind = match.kind.trim().toLowerCase();
    const value = match.value.trim();
    if (!isRoutingMetadataMatch(match) || !value) continue;

    sourceMetadata[kind] = value;
    if (kind === "local_endpoint") {
      adapterConfig.base_url = value;
    }
    if (kind === "local_workspace_root") {
      adapterConfig.workspace_root = value;
    }
    if (kind === "local_machine") {
      adapterConfig.local_machine = value;
    }
  }

  return { adapterConfig, sourceMetadata };
}

export async function resolveRoutingRule(input: {
  agent: AgentProfileRow;
  role: AgentRole;
  rule: RoutingRuleRow;
  matches: RoutingRuleMatchRow[];
  fallbacks: RoutingRuleFallbackRow[];
  accessToken?: string;
}) {
  return buildRuleResolution({
    agent: input.agent,
    role: input.role,
    rule: input.rule,
    matches: input.matches.filter((match) => match.rule_id === input.rule.id),
    fallbacks: input.fallbacks.filter((fallback) => fallback.routing_rule_id === input.rule.id),
    accessToken: input.accessToken,
  });
}
