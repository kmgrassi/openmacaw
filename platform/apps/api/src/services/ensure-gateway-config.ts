import { deriveProviderFromModel, extractPrimaryModel } from "../../../../contracts/agent-helpers.js";
import { ModelSettingsSchema } from "../../../../contracts/agents.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { buildExecutionProfileBlock, defaultAgentGatewayConfig, hashConfig, asJson } from "./setup/builders.js";
import type { DefaultAgentRole } from "../../../../contracts/setup.js";
import type { Tables } from "@kmgrassi/supabase-schema";

type AgentGatewayConfigFields = Pick<Tables<"agent">, "model_settings">;

/**
 * Ensures a gateway_config row exists for the given agent.
 *
 * When credentials are saved outside the full setup flow (e.g. Settings > Agents > Credentials),
 * no gateway config is created, so we auto-create a default one if missing.
 *
 * This is idempotent — if a config already exists, it's a no-op.
 */
export async function ensureGatewayConfigExists(input: {
  agentId: string;
  role: DefaultAgentRole;
  provider?: string | null;
  model?: string | null;
}): Promise<void> {
  const supabase = getServiceRoleSupabase();

  const { data: existing, error: selectError } = await supabase
    .from("gateway_config")
    .select("id")
    .eq("scope_type", "agent")
    .eq("scope_id", input.agentId)
    .maybeSingle();

  if (selectError) {
    console.error("[ensureGatewayConfigExists] Failed to check for existing gateway config:", selectError);
    return;
  }

  if (existing) {
    return;
  }

  const model = input.model?.trim() || (await loadAgentPrimaryModel(input.agentId));
  const provider = input.provider?.trim() || deriveProviderFromModel(model);
  if (!model || !provider) {
    console.error("[ensureGatewayConfigExists] Cannot create gateway config without model and provider", {
      agentId: input.agentId,
      role: input.role,
      hasModel: Boolean(model),
      hasProvider: Boolean(provider),
    });
    return;
  }

  const resolution = await resolveExecutionProfile({
    agentId: input.agentId,
    skipCredentialCheck: true,
  }).catch((error: unknown) => {
    console.warn("[ensureGatewayConfigExists] Failed to resolve execution profile", {
      agentId: input.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  const executionProfile = buildExecutionProfileBlock(resolution);
  const configJson = defaultAgentGatewayConfig(input.role, provider, model, undefined, executionProfile);
  const configHash = hashConfig(configJson);

  const { error: insertError } = await supabase.from("gateway_config").insert({
    scope_type: "agent",
    scope_id: input.agentId,
    version: 1,
    config_hash: configHash,
    config_json: asJson(configJson),
    updated_by: "00000000-0000-0000-0000-000000000000",
  });

  if (insertError) {
    // A unique constraint violation means another request created it concurrently — that's fine.
    if (insertError.code === "23505") {
      console.log("[ensureGatewayConfigExists] Gateway config was concurrently created for agent", input.agentId);
      return;
    }
    console.error("[ensureGatewayConfigExists] Failed to insert default gateway config:", insertError);
    return;
  }

  console.log(
    "[ensureGatewayConfigExists] Auto-created default gateway config for agent",
    input.agentId,
    `(role=${input.role}, provider=${provider}, model=${model})`,
  );
}

async function loadAgentPrimaryModel(agentId: string): Promise<string | null> {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase.from("agent").select("model_settings").eq("id", agentId).limit(1);
  if (error) {
    console.error("[ensureGatewayConfigExists] Failed to load agent model settings:", error);
    return null;
  }

  const agent = (data ?? [])[0] as AgentGatewayConfigFields | undefined;
  return extractPrimaryModel(ModelSettingsSchema.parse(agent?.model_settings ?? {}));
}
