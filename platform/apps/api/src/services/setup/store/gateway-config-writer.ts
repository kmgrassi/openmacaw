import type { DefaultAgentRole } from "../../../../../../contracts/setup.js";
import { ApiRouteError } from "../../../http.js";
import { getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { resolveExecutionProfile } from "../../execution-profile-resolver.js";
import {
  asJson,
  buildChangeSummary,
  buildExecutionProfileBlock,
  defaultAgentGatewayConfig,
  hashConfig,
  repairGatewayConfig,
  repairManagerGatewayConfig,
} from "../builders.js";
import type { AgentRow, GatewayConfigRow } from "../types.js";
import { getGatewayConfig } from "./readers.js";
import { GATEWAY_CONFIG_SELECT } from "./selects.js";

async function resolveExecutionProfileBlock(agentId: string, accessToken: string) {
  try {
    const resolution = await resolveExecutionProfile({
      agentId,
      accessToken,
      skipCredentialCheck: true,
    });
    return buildExecutionProfileBlock(resolution);
  } catch (error) {
    // Resolution can fail for incomplete agents (no routing rule yet). The
    // runtime will fall back to the legacy gateway-config-runner code path
    // until the next write, which is no worse than today.
    console.warn("[gateway-config-writer] Failed to resolve execution profile", {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function writeGatewayConfigForDefaultAgent(
  accessToken: string,
  userId: string,
  agent: AgentRow,
  role: DefaultAgentRole,
  provider: string,
  model: string,
  runnerKind?: Parameters<typeof defaultAgentGatewayConfig>[3],
) {
  const existingGatewayConfig = await getGatewayConfig(accessToken, agent.id);
  const executionProfile = await resolveExecutionProfileBlock(agent.id, accessToken);
  const nextConfigJson = existingGatewayConfig
    ? repairGatewayConfig(existingGatewayConfig.config_json, role, provider, model, runnerKind, executionProfile)
    : defaultAgentGatewayConfig(role, provider, model, runnerKind, executionProfile);
  const nextConfigHash = hashConfig(nextConfigJson);

  if (!existingGatewayConfig) {
    const { data, error } = await getUserScopedSupabase(accessToken)
      .from("gateway_config")
      .insert({
        scope_type: "agent",
        scope_id: agent.id,
        version: 1,
        config_hash: nextConfigHash,
        config_json: asJson(nextConfigJson),
        updated_by: userId,
      })
      .select(GATEWAY_CONFIG_SELECT);

    if (error) throw normalizeSupabaseError("gateway_config insert", error);
    const createdGatewayConfig = data[0] as GatewayConfigRow | undefined;
    if (!createdGatewayConfig) {
      throw new ApiRouteError(502, "gateway_config_create_failed", "Gateway config creation returned no row");
    }

    const { error: versionError } = await getUserScopedSupabase(accessToken)
      .from("gateway_config_versions")
      .insert({
        gateway_config_id: createdGatewayConfig.id,
        version: createdGatewayConfig.version,
        config_hash: createdGatewayConfig.config_hash,
        config_json: createdGatewayConfig.config_json,
        created_by: userId,
        change_summary: asJson({ created: true, default_agent_role: role }),
      });
    if (versionError) throw normalizeSupabaseError("gateway_config_versions insert", versionError);
    return;
  }

  const nextVersion = existingGatewayConfig.version + 1;
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("gateway_config")
    .update({
      version: nextVersion,
      config_hash: nextConfigHash,
      config_json: asJson(nextConfigJson),
      updated_by: userId,
    })
    .eq("id", existingGatewayConfig.id)
    .select(GATEWAY_CONFIG_SELECT);

  if (error) throw normalizeSupabaseError("gateway_config update", error);
  const updatedGatewayConfig = data[0] as GatewayConfigRow | undefined;
  if (!updatedGatewayConfig) {
    throw new ApiRouteError(502, "gateway_config_update_failed", "Gateway config update returned no row");
  }

  const { error: versionError } = await getUserScopedSupabase(accessToken)
    .from("gateway_config_versions")
    .insert({
      gateway_config_id: updatedGatewayConfig.id,
      version: nextVersion,
      config_hash: nextConfigHash,
      config_json: asJson(nextConfigJson),
      created_by: userId,
      change_summary: asJson(buildChangeSummary(existingGatewayConfig.config_json, nextConfigJson)),
    });
  if (versionError) throw normalizeSupabaseError("gateway_config_versions insert", versionError);
}

export async function writeGatewayConfigForManagerAgent(input: {
  accessToken: string;
  userId: string;
  agent: AgentRow;
  provider: string;
  model: string;
  runnerKind: "llm_tool_runner";
  cadenceMs?: number;
}) {
  const existingGatewayConfig = await getGatewayConfig(input.accessToken, input.agent.id);
  const executionProfile = await resolveExecutionProfileBlock(input.agent.id, input.accessToken);
  const nextConfigJson = repairManagerGatewayConfig({
    configJson: existingGatewayConfig?.config_json,
    provider: input.provider,
    model: input.model,
    runnerKind: input.runnerKind,
    cadenceMs: input.cadenceMs,
    executionProfile,
  });
  const nextConfigHash = hashConfig(nextConfigJson);

  if (!existingGatewayConfig) {
    const { data, error } = await getUserScopedSupabase(input.accessToken)
      .from("gateway_config")
      .insert({
        scope_type: "agent",
        scope_id: input.agent.id,
        version: 1,
        config_hash: nextConfigHash,
        config_json: asJson(nextConfigJson),
        updated_by: input.userId,
      })
      .select(GATEWAY_CONFIG_SELECT);

    if (error) throw normalizeSupabaseError("gateway_config insert", error);
    const createdGatewayConfig = data[0] as GatewayConfigRow | undefined;
    if (!createdGatewayConfig) {
      throw new ApiRouteError(502, "gateway_config_create_failed", "Gateway config creation returned no row");
    }

    const { error: versionError } = await getUserScopedSupabase(input.accessToken)
      .from("gateway_config_versions")
      .insert({
        gateway_config_id: createdGatewayConfig.id,
        version: createdGatewayConfig.version,
        config_hash: createdGatewayConfig.config_hash,
        config_json: createdGatewayConfig.config_json,
        created_by: input.userId,
        change_summary: asJson({ created: true, manager_agent: true }),
      });
    if (versionError) throw normalizeSupabaseError("gateway_config_versions insert", versionError);
    return;
  }

  const nextVersion = existingGatewayConfig.version + 1;
  const { data, error } = await getUserScopedSupabase(input.accessToken)
    .from("gateway_config")
    .update({
      version: nextVersion,
      config_hash: nextConfigHash,
      config_json: asJson(nextConfigJson),
      updated_by: input.userId,
    })
    .eq("id", existingGatewayConfig.id)
    .select(GATEWAY_CONFIG_SELECT);

  if (error) throw normalizeSupabaseError("gateway_config update", error);
  const updatedGatewayConfig = data[0] as GatewayConfigRow | undefined;
  if (!updatedGatewayConfig) {
    throw new ApiRouteError(502, "gateway_config_update_failed", "Gateway config update returned no row");
  }

  const { error: versionError } = await getUserScopedSupabase(input.accessToken)
    .from("gateway_config_versions")
    .insert({
      gateway_config_id: updatedGatewayConfig.id,
      version: nextVersion,
      config_hash: nextConfigHash,
      config_json: asJson(nextConfigJson),
      created_by: input.userId,
      change_summary: asJson(buildChangeSummary(existingGatewayConfig.config_json, nextConfigJson)),
    });
  if (versionError) throw normalizeSupabaseError("gateway_config_versions insert", versionError);
}
