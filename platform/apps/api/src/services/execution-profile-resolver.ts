import { deriveProviderFromModel, extractPrimaryModel } from "../../../../contracts/agent-helpers.js";
import { ModelSettingsSchema } from "../../../../contracts/agents.js";
import type { ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import { normalizeRunnerKind } from "../../../../contracts/runner-kinds.js";
import { buildResolution } from "./execution-profile-resolver/build-resolution.js";
import { normalizeRole } from "./execution-profile-resolver/credential-state.js";
import { firstGatewayRunner, legacyCredentialRef } from "./execution-profile-resolver/gateway-runner.js";
import {
  getAgent,
  getAgentCredentialId,
  getAgentGatewayConfig,
  getRoutingRuleFallbacks,
  getRoutingRules,
  getRuleMatches,
  hasScopedCredential,
} from "./execution-profile-resolver/queries.js";
import { resolveRoutingRule, selectRoutingRule } from "./execution-profile-resolver/routing-rules.js";
import type { ResolveExecutionProfileInput } from "./execution-profile-resolver/types.js";

export type { ResolveExecutionProfileInput } from "./execution-profile-resolver/types.js";
export { firstGatewayRunner } from "./execution-profile-resolver/gateway-runner.js";
export { isRoutingMetadataMatch, matchValue } from "./execution-profile-resolver/routing-rules.js";

export async function resolveExecutionProfile(
  input: ResolveExecutionProfileInput,
): Promise<ExecutionProfileResolution> {
  const agent = await getAgent(input);
  const role = normalizeRole(agent.type);
  const intent = input.intent?.trim() || null;
  const intentKey = input.intentKey?.trim() || null;
  const rules = await getRoutingRules(agent.workspace_id, input.accessToken);
  const matches = await getRuleMatches(
    agent.workspace_id,
    rules.map((rule) => rule.id),
    input.accessToken,
  );
  const fallbacks = await getRoutingRuleFallbacks(
    agent.workspace_id,
    rules.map((rule) => rule.id),
    input.accessToken,
  );
  if (process.env.NODE_ENV === "development") {
    console.log(`[resolver] agent=${input.agentId} rules=${rules.length} matches=${matches.length}`);
    for (const m of matches) {
      console.log(`[resolver]   match rule=${m.rule_id} kind=${m.kind} key=${m.key} value=${m.value}`);
    }
  }
  const rule = selectRoutingRule({ agent, role, intent, intentKey, rules, matches });

  if (process.env.NODE_ENV === "development") {
    console.log(`[resolver] selectedRule=${rule?.id ?? "none"} runner_kind=${rule?.runner_kind ?? "n/a"}`);
  }

  if (rule) {
    const resolution = await resolveRoutingRule({
      agent,
      role,
      rule,
      matches,
      fallbacks,
      accessToken: input.accessToken,
    });
    return resolution;
  }

  const gatewayConfig = await getAgentGatewayConfig(input);
  const runner = firstGatewayRunner(gatewayConfig?.config_json);
  const model =
    (typeof runner?.model === "string" && runner.model.trim()) ||
    extractPrimaryModel(ModelSettingsSchema.parse(agent.model_settings));
  const provider = (typeof runner?.provider === "string" && runner.provider.trim()) || deriveProviderFromModel(model);
  const credentialRef = legacyCredentialRef(runner);
  const scopedCredential = credentialRef ? false : await hasScopedCredential(input, agent);
  const credentialId =
    credentialRef || scopedCredential || input.skipCredentialCheck
      ? null
      : await getAgentCredentialId(agent.id, agent.workspace_id, input.accessToken);

  return buildResolution({
    agent,
    role,
    runnerKind: normalizeRunnerKind(runner?.kind) ?? (runner ? "codex" : null),
    provider,
    model,
    credentialRef: credentialRef ?? (credentialId ? { type: "credential_id", value: credentialId } : null),
    hasCredential:
      Boolean(credentialRef) || scopedCredential || Boolean(credentialId) || Boolean(input.skipCredentialCheck),
    routingRuleId: null,
    credentialAlias: null,
    fallbackUsed: true,
    legacyGatewayConfigUsed: Boolean(gatewayConfig),
  });
}
