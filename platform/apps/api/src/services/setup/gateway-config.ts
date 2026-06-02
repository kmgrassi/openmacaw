import { getUserScopedSupabase, normalizeSupabaseError } from "../../supabase-client.js";
import { asJson, buildModelSettings } from "./builders.js";
import type { buildGatewayConfig } from "./builders.js";
import type { GatewayConfigRow } from "./types.js";
import type { ToolPolicy } from "../../../../../contracts/agents.js";

const GATEWAY_CONFIG_SELECT = "id,scope_type,scope_id,version,config_hash,config_json,updated_at,updated_by" as const;

export async function updateAgentModelSettings(accessToken: string, agentId: string, model: string) {
  const { error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .update({
      model_settings: asJson(buildModelSettings(model)),
    })
    .eq("id", agentId)
    .select("id");

  if (error) throw normalizeSupabaseError("agent update", error);
}

export async function updateAgentRuntimeDefaults(
  accessToken: string,
  agentId: string,
  model: string,
  toolPolicy: ToolPolicy,
) {
  const { error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .update({
      model_settings: asJson(buildModelSettings(model)),
      tool_policy: asJson(toolPolicy),
    })
    .eq("id", agentId)
    .select("id");

  if (error) throw normalizeSupabaseError("agent update", error);
}

export async function createGatewayConfig(input: {
  accessToken: string;
  agentId: string;
  userId: string;
  configHash: string;
  configJson: ReturnType<typeof buildGatewayConfig>;
}) {
  const { data, error } = await getUserScopedSupabase(input.accessToken)
    .from("gateway_config")
    .insert({
      scope_type: "agent",
      scope_id: input.agentId,
      version: 1,
      config_hash: input.configHash,
      config_json: asJson(input.configJson),
      updated_by: input.userId,
    })
    .select(GATEWAY_CONFIG_SELECT);

  if (error) throw normalizeSupabaseError("gateway_config insert", error);
  return (data[0] as GatewayConfigRow | undefined) ?? null;
}

export async function updateGatewayConfig(input: {
  accessToken: string;
  gatewayConfigId: string;
  userId: string;
  version: number;
  configHash: string;
  configJson: ReturnType<typeof buildGatewayConfig>;
}) {
  const { data, error } = await getUserScopedSupabase(input.accessToken)
    .from("gateway_config")
    .update({
      version: input.version,
      config_hash: input.configHash,
      config_json: asJson(input.configJson),
      updated_by: input.userId,
    })
    .eq("id", input.gatewayConfigId)
    .select(GATEWAY_CONFIG_SELECT);

  if (error) throw normalizeSupabaseError("gateway_config update", error);
  return (data[0] as GatewayConfigRow | undefined) ?? null;
}

export async function createGatewayConfigVersion(input: {
  accessToken: string;
  gatewayConfigId: string;
  version: number;
  configHash: string;
  configJson: GatewayConfigRow["config_json"];
  userId: string;
  changeSummary: unknown;
}) {
  const { error } = await getUserScopedSupabase(input.accessToken)
    .from("gateway_config_versions")
    .insert({
      gateway_config_id: input.gatewayConfigId,
      version: input.version,
      config_hash: input.configHash,
      config_json: input.configJson,
      created_by: input.userId,
      change_summary: asJson(input.changeSummary),
    });

  if (error) throw normalizeSupabaseError("gateway_config_versions insert", error);
}
