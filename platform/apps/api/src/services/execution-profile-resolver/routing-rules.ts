import { deriveProviderFromModel, extractPrimaryModel } from "../../../../../contracts/agent-helpers.js";
import { ModelSettingsSchema } from "../../../../../contracts/agents.js";
import type { AgentRole, ExecutionProfileResolution } from "../../../../../contracts/execution-profile.js";
import { normalizeRunnerKind } from "../../../../../contracts/runner-kinds.js";
import { buildResolution } from "./build-resolution.js";
import { resolveCredentialAlias } from "./queries.js";
import type { AgentProfileRow, RoutingRuleMatchRow, RoutingRuleRow } from "./types.js";

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
  return kind === "local_endpoint" || kind === "local_workspace_root" || kind === "local_machine";
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
  accessToken?: string;
}) {
  const credentialId =
    input.rule.credential_id ??
    (input.rule.credential_alias
      ? await resolveCredentialAlias(input.agent.workspace_id, input.rule.credential_alias, input.accessToken)
      : null);
  const model = input.rule.model?.trim() || extractPrimaryModel(ModelSettingsSchema.parse(input.agent.model_settings));
  const metadata = routingMetadata(input.matches);
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
    adapterConfig: metadata.adapterConfig,
    sourceMetadata: metadata.sourceMetadata,
  });
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

export async function resolveRoutingRuleChain(input: {
  agent: AgentProfileRow;
  role: AgentRole;
  rule: RoutingRuleRow;
  rulesById: Map<string, RoutingRuleRow>;
  matches: RoutingRuleMatchRow[];
  accessToken?: string;
}) {
  const visited = new Set<string>();
  let current: RoutingRuleRow | undefined = input.rule;
  let lastResolution: ExecutionProfileResolution | null = null;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    lastResolution = await buildRuleResolution({
      agent: input.agent,
      role: input.role,
      rule: current,
      matches: input.matches.filter((match) => match.rule_id === current.id),
      accessToken: input.accessToken,
    });
    if (lastResolution.missing.length === 0 || !current.next_fallback_rule_id) return lastResolution;
    current = input.rulesById.get(current.next_fallback_rule_id);
  }

  return lastResolution;
}
