import { deriveProviderFromModel } from "../../../../contracts/agent-helpers.js";
import {
  AgentRuntimeProfileSchema,
  AgentRuntimeProviderSchema,
  type AgentRuntimeProfile,
  type AgentRuntimeProfileUpdateRequest,
} from "../../../../contracts/agents.js";
import type { CredentialReference } from "../../../../contracts/credentials.js";
import type { KnownExecutionProvider } from "../../../../contracts/execution-profile.js";
import { ApiRouteError } from "../http.js";
import { findStoredAgentRowById, getStoredAgentGatewayConfig, updateStoredAgentRow } from "../repositories/agents.js";
import {
  credentialRefFromRoutingRule,
  getAgentCredentialReferenceRule,
  getRoutingRuleLocalEndpointUrl,
  upsertAgentCredentialReferenceRule,
} from "../repositories/routing-rules.js";
import { getCredentialRowByIdForWorkspace, resolveCredentialAlias } from "../repositories/credentials.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { ensureGatewayConfigExists } from "./ensure-gateway-config.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { asJson, buildChangeSummary, hashConfig } from "./setup/builders.js";
import { createStoredAgentGatewayConfigVersion, updateStoredAgentGatewayConfig } from "../repositories/agents.js";
import { defaultRunnerKindForAgentType } from "../../../../contracts/agent-runner-defaults.js";
import { ModelSettingsSchema, ToolPolicySchema, normalizeAgentType } from "../../../../contracts/agents.js";

const HOSTED_PROVIDERS = new Set<KnownExecutionProvider>(["openai", "openai_compatible", "anthropic"]);

function runnerKindForRuntimeProfile(agentType: string | null | undefined, provider: KnownExecutionProvider) {
  // Coding agents pointed at a local provider use the local-coding
  // runtime instead of the cloud-hosted codex runner — different
  // executionLocation, different transport. Every other agent type
  // uses the canonical default (which is provider-agnostic, since
  // runner_kind describes capability, not the model backing it).
  if (agentType === "coding" && provider === "local") return "local_model_coding";
  return defaultRunnerKindForAgentType(agentType);
}

function credentialRequired(input: {
  runnerKind: string;
  provider: KnownExecutionProvider;
  localEndpointUrl?: string | null;
}) {
  if (!HOSTED_PROVIDERS.has(input.provider)) return false;
  if (input.provider === "openai_compatible" && input.localEndpointUrl?.trim()) return false;
  return true;
}

async function hasLocalHelper(input: { workspaceId: string; runnerKind: string }) {
  const { data, error } = await getServiceRoleSupabase()
    .from("local_runtime_machine")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .is("revoked_at", null)
    .contains("runner_kinds", [input.runnerKind])
    .limit(1);
  if (error) throw normalizeSupabaseError("local_runtime_machine query", error);
  return (data ?? []).length > 0;
}

function updateGatewayRuntimeConfig(input: {
  currentConfig: unknown;
  provider: KnownExecutionProvider;
  model: string;
  runnerKind: string;
}) {
  const root =
    input.currentConfig && typeof input.currentConfig === "object" && !Array.isArray(input.currentConfig)
      ? { ...(input.currentConfig as Record<string, unknown>) }
      : {};
  const runners = root.runners;
  const patch = {
    kind: input.runnerKind,
    provider: input.provider,
    model: input.model,
  };

  if (Array.isArray(runners)) {
    const firstRunner = typeof runners[0] === "object" && runners[0] !== null ? runners[0] : {};
    return {
      ...root,
      runners: [{ ...firstRunner, ...patch }, ...runners.slice(1)],
    };
  }

  return {
    ...root,
    runners: [{ ...patch }],
  };
}

async function persistAgentGatewayRuntimeConfig(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  provider: KnownExecutionProvider;
  model: string;
  runnerKind: string;
}) {
  const existing = await getStoredAgentGatewayConfig(input.accessToken, input.agentId);
  if (!existing) {
    await ensureGatewayConfigExists({
      agentId: input.agentId,
      role: input.runnerKind === "planner" || input.runnerKind === "llm_tool_runner" ? "planning" : "coding",
      provider: input.provider,
      model: input.model,
    });
  }

  const current = existing ?? (await getStoredAgentGatewayConfig(input.accessToken, input.agentId));
  if (!current) return;

  const nextConfig = updateGatewayRuntimeConfig({
    currentConfig: current.config_json,
    provider: input.provider,
    model: input.model,
    runnerKind: input.runnerKind,
  });
  const nextVersion = current.version + 1;
  const configHash = hashConfig(nextConfig);
  const updated = await updateStoredAgentGatewayConfig({
    accessToken: input.accessToken,
    gatewayConfigId: current.id,
    userId: input.userId,
    version: nextVersion,
    configHash,
    configJson: asJson(nextConfig),
  });
  if (!updated) throw new ApiRouteError(502, "gateway_config_update_failed", "Gateway config update returned no row");
  await createStoredAgentGatewayConfigVersion({
    accessToken: input.accessToken,
    gatewayConfigId: updated.id,
    userId: input.userId,
    version: nextVersion,
    configHash,
    configJson: updated.config_json,
    changeSummary: asJson(buildChangeSummary(current.config_json, nextConfig)),
  });
}

async function updateAgentPrimaryModel(input: {
  accessToken: string;
  agentId: string;
  existing: Awaited<ReturnType<typeof findStoredAgentRowById>>;
  model: string;
}) {
  if (!input.existing) return;
  const currentSettings = ModelSettingsSchema.parse(input.existing.model_settings);
  const nextSettings = ModelSettingsSchema.parse({ ...currentSettings, primary: input.model });
  await updateStoredAgentRow({
    accessToken: input.accessToken,
    agentId: input.agentId,
    name: input.existing.name?.trim() || input.agentId,
    type: input.existing.type ?? "coding",
    modelSettings: nextSettings,
    toolPolicy: ToolPolicySchema.parse(input.existing.tool_policy),
  });
}

function assertCredentialPolicy(input: {
  agentType: string | null;
  runnerKind: string;
  provider: KnownExecutionProvider;
  credentialRef: CredentialReference | null;
  localEndpointUrl?: string | null;
}) {
  if (credentialRequired(input) && !input.credentialRef) {
    throw new ApiRouteError(400, "credential_required", "Hosted providers require a credential reference");
  }
}

async function assertCredentialReferenceBelongsToWorkspace(input: {
  workspaceId: string;
  credentialRef: CredentialReference | null;
}) {
  if (!input.credentialRef) return;

  if (input.credentialRef.type === "alias") {
    const alias = await resolveCredentialAlias(input.workspaceId, input.credentialRef.value);
    if (!alias) throw new ApiRouteError(404, "credential_alias_not_found", "Credential alias was not found");
    return;
  }

  const credential = await getCredentialRowByIdForWorkspace(input.credentialRef.value, input.workspaceId);
  if (!credential) throw new ApiRouteError(404, "credential_not_found", "Credential was not found");
}

export async function getAgentRuntimeProfile(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}): Promise<AgentRuntimeProfile> {
  const agent = await findStoredAgentRowById(input.accessToken, input.agentId);
  if (!agent) throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  if (input.workspaceId && agent.workspace_id !== input.workspaceId) {
    throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  }

  const rule = await getAgentCredentialReferenceRule({
    agentId: agent.id,
    workspaceId: agent.workspace_id,
  });
  const resolution = await resolveExecutionProfile({
    accessToken: input.accessToken,
    requesterUserId: input.userId,
    agentId: agent.id,
    skipCredentialCheck: true,
  });
  const profile = resolution.profile;
  const model = rule?.model ?? profile?.model ?? "";
  const provider = rule?.provider ?? profile?.provider ?? deriveProviderFromModel(model);
  const agentType = normalizeAgentType(agent.type);
  const parsedProvider = AgentRuntimeProviderSchema.safeParse(provider);
  if (!model || !parsedProvider.success) {
    throw new ApiRouteError(422, "runtime_profile_incomplete", "Agent runtime profile is missing a model or provider");
  }
  const runnerKind =
    rule?.runner_kind ?? profile?.runnerKind ?? runnerKindForRuntimeProfile(agentType, parsedProvider.data);
  const localEndpointUrl = rule
    ? await getRoutingRuleLocalEndpointUrl({
        ruleId: rule.id,
        workspaceId: agent.workspace_id,
      })
    : null;

  return AgentRuntimeProfileSchema.parse({
    agentId: agent.id,
    workspaceId: agent.workspace_id,
    agentType,
    runnerKind,
    provider: parsedProvider.data,
    model,
    credentialRef: credentialRefFromRoutingRule(rule) ?? profile?.credentialRef ?? null,
    localEndpointUrl,
    localHelperRegistered:
      provider === "local" ? await hasLocalHelper({ workspaceId: agent.workspace_id, runnerKind }) : false,
    updatedAt: rule?.updated_at ?? null,
  });
}

export async function updateAgentRuntimeProfile(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  body: AgentRuntimeProfileUpdateRequest;
}): Promise<AgentRuntimeProfile> {
  const agent = await findStoredAgentRowById(input.accessToken, input.agentId);
  if (!agent) throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  if (agent.workspace_id !== input.body.workspaceId) {
    throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  }

  const agentType = normalizeAgentType(agent.type);
  const runnerKind = runnerKindForRuntimeProfile(agentType, input.body.provider);
  const credentialRef = input.body.provider === "local" ? null : (input.body.credentialRef ?? null);
  assertCredentialPolicy({
    agentType,
    runnerKind,
    provider: input.body.provider,
    credentialRef,
    localEndpointUrl: input.body.localEndpointUrl,
  });
  await assertCredentialReferenceBelongsToWorkspace({
    workspaceId: agent.workspace_id,
    credentialRef,
  });

  await updateAgentPrimaryModel({
    accessToken: input.accessToken,
    agentId: agent.id,
    existing: agent,
    model: input.body.model,
  });

  await upsertAgentCredentialReferenceRule({
    agentId: agent.id,
    workspaceId: agent.workspace_id,
    runnerKind,
    provider: input.body.provider,
    model: input.body.model,
    credentialRef,
    localEndpointUrl: input.body.localEndpointUrl ?? null,
  });

  if (agentType === "planning" || agentType === "coding") {
    await persistAgentGatewayRuntimeConfig({
      accessToken: input.accessToken,
      userId: input.userId,
      agentId: agent.id,
      provider: input.body.provider,
      model: input.body.model,
      runnerKind,
    });
  }

  return getAgentRuntimeProfile({
    accessToken: input.accessToken,
    userId: input.userId,
    agentId: agent.id,
    workspaceId: agent.workspace_id,
  });
}
