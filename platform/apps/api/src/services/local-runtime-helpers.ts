import { AgentLocalRuntimeAssignResponseSchema } from "../../../../contracts/local-runtime.js";
import { ApiRouteError } from "../http.js";
import { assertSupabaseNoError, assertSupabaseSuccess } from "../lib/supabase-errors.js";
import { getRoutingRuleLocalEndpointUrl } from "../repositories/routing-rules.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { updateAgentRuntimeProfileForAuthenticatedUser } from "./agent-runtime-profile.js";
import {
  LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX,
  REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS,
} from "./local-runtime/routing-metadata.js";

export async function assignLocalModelToAgent(input: {
  workspaceId: string;
  ruleId: string;
  agentId: string;
  auth: {
    accessToken: string;
    userId: string;
  };
}) {
  const supabase = getServiceRoleSupabase();

  const { data: rule, error: ruleError } = await supabase
    .from("routing_rule")
    .select("id, model, provider, runner_kind")
    .eq("id", input.ruleId)
    .eq("workspace_id", input.workspaceId)
    .in("runner_kind", [...REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS])
    .like("name", `${LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX}%`)
    .single();

  if (ruleError || !rule) {
    throw new ApiRouteError(404, "local_runtime_not_found", "Local runtime was not found");
  }

  // Cleanup must touch only registration-created rules. Credential-reference
  // rules (name `agent:<agentId>:execution-profile`) can also carry
  // runner_kind = local_relay; their single agent_id match is the agent's
  // own credential pointer and must not be deleted here. The `local:` name
  // prefix is the registration flow's invariant.
  const { data: registrationRules, error: registrationRulesError } = await supabase
    .from("routing_rule")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .in("runner_kind", [...REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS])
    .like("name", `${LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX}%`);

  assertSupabaseSuccess("list registered local runtime rules", registrationRules, registrationRulesError);

  const registrationRuleIds = (registrationRules ?? [])
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (registrationRuleIds.length > 0) {
    const { error: deleteMatchError } = await supabase
      .from("routing_rule_match")
      .delete()
      .eq("workspace_id", input.workspaceId)
      .eq("kind", "agent_id")
      .eq("value", input.agentId)
      .in("rule_id", registrationRuleIds);

    if (deleteMatchError) {
      assertSupabaseSuccess("remove existing local runtime assignment for agent", null, deleteMatchError);
    }
  }

  const { data: matchId, error: matchError } = await supabase
    .from("routing_rule_match")
    .insert({
      workspace_id: input.workspaceId,
      rule_id: input.ruleId,
      kind: "agent_id",
      key: "agent_id",
      value: input.agentId,
    })
    .select("id")
    .single();

  assertSupabaseSuccess("assign local runtime to agent", matchId, matchError);

  const { data: agent, error: agentError } = await supabase
    .from("agent")
    .select("id, type")
    .eq("id", input.agentId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  assertSupabaseNoError("read assigned local runtime agent", agentError);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  const provider = rule.provider?.trim();
  const model = rule.model?.trim();
  if (agent.type === "manager" && provider === "openai_compatible" && model) {
    const localEndpointUrl = await getRoutingRuleLocalEndpointUrl({
      ruleId: input.ruleId,
      workspaceId: input.workspaceId,
    });
    await updateAgentRuntimeProfileForAuthenticatedUser({
      auth: input.auth,
      agentId: input.agentId,
      body: {
        workspaceId: input.workspaceId,
        provider: "local",
        model,
        credentialRef: null,
        localEndpointUrl,
      },
    });
  }

  return AgentLocalRuntimeAssignResponseSchema.parse({
    routingRuleId: input.ruleId,
    agentId: input.agentId,
    model: rule.model ?? "",
  });
}

export async function assignLocalModelByMachineToAgent(input: {
  workspaceId: string;
  machineId: string;
  agentId: string;
  model: string;
  provider: string;
  auth: {
    accessToken: string;
    userId: string;
  };
}) {
  const supabase = getServiceRoleSupabase();

  const { data: machineMatches, error: machineMatchError } = await supabase
    .from("routing_rule_match")
    .select("rule_id")
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "local_machine")
    .eq("key", "id")
    .eq("value", input.machineId);

  assertSupabaseSuccess("find local runtime machine rules", machineMatches, machineMatchError);

  const ruleIds = Array.from(
    new Set(
      (machineMatches ?? [])
        .map((row) => row.rule_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (ruleIds.length === 0) {
    throw new ApiRouteError(404, "local_runtime_not_found", "Local runtime machine was not found");
  }

  const { data: rules, error: rulesError } = await supabase
    .from("routing_rule")
    .select("id, model, provider, runner_kind, name")
    .eq("workspace_id", input.workspaceId)
    .in("id", ruleIds)
    .in("runner_kind", [...REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS])
    .like("name", `${LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX}%`);

  assertSupabaseSuccess("find local runtime model rule", rules, rulesError);

  const requestedModel = input.model.trim();
  const requestedProvider = input.provider.trim();
  const rule = (rules ?? []).find(
    (candidate) =>
      candidate.model?.trim() === requestedModel &&
      (candidate.provider?.trim() ?? "openai_compatible") === requestedProvider,
  );

  if (!rule?.id) {
    throw new ApiRouteError(
      404,
      "local_model_not_advertised",
      "Selected model is not advertised by that local runtime",
    );
  }

  return assignLocalModelToAgent({
    workspaceId: input.workspaceId,
    ruleId: rule.id,
    agentId: input.agentId,
    auth: input.auth,
  });
}

export async function unassignLocalModelFromAgent(input: {
  workspaceId: string;
  ruleId: string;
  agentId: string;
  userId: string;
}) {
  const supabase = getServiceRoleSupabase();

  const { data: rule, error: ruleError } = await supabase
    .from("routing_rule")
    .select("id, model, provider")
    .eq("id", input.ruleId)
    .eq("workspace_id", input.workspaceId)
    .in("runner_kind", [...REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS])
    .like("name", `${LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX}%`)
    .single();

  if (ruleError || !rule) {
    throw new ApiRouteError(404, "local_runtime_not_found", "Local runtime was not found");
  }

  const { error: deleteError } = await supabase
    .from("routing_rule_match")
    .delete()
    .eq("rule_id", input.ruleId)
    .eq("kind", "agent_id")
    .eq("value", input.agentId);

  if (deleteError) {
    assertSupabaseSuccess("remove local runtime assignment", null, deleteError);
  }

  const { data: agent, error: agentError } = await supabase
    .from("agent")
    .select("id, type")
    .eq("id", input.agentId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  assertSupabaseNoError("read unassigned local runtime agent", agentError);

  const provider = rule.provider?.trim();
  const model = rule.model?.trim();
  if (agent?.type !== "manager" || provider !== "openai_compatible" || !model) {
    return;
  }
  const managerRuntimeProfileProvider = "local";

  const localEndpointUrl = await getRoutingRuleLocalEndpointUrl({
    ruleId: input.ruleId,
    workspaceId: input.workspaceId,
  });
  if (!localEndpointUrl) {
    return;
  }

  const { data: runtimeProfileRule, error: runtimeProfileRuleError } = await supabase
    .from("routing_rule")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("name", `agent:${input.agentId}:execution-profile`)
    .eq("provider", managerRuntimeProfileProvider)
    .eq("model", model)
    .maybeSingle();

  assertSupabaseNoError("read manager local runtime profile", runtimeProfileRuleError);
  if (!runtimeProfileRule?.id) {
    return;
  }

  const runtimeProfileEndpointUrl = await getRoutingRuleLocalEndpointUrl({
    ruleId: runtimeProfileRule.id,
    workspaceId: input.workspaceId,
  });
  if (runtimeProfileEndpointUrl !== localEndpointUrl) {
    return;
  }

  const { error: deleteRuntimeProfileMatchesError } = await supabase
    .from("routing_rule_match")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("rule_id", runtimeProfileRule.id);

  if (deleteRuntimeProfileMatchesError) {
    assertSupabaseSuccess("remove manager local runtime profile matches", null, deleteRuntimeProfileMatchesError);
  }

  const { error: deleteRuntimeProfileError } = await supabase
    .from("routing_rule")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("id", runtimeProfileRule.id);

  if (deleteRuntimeProfileError) {
    assertSupabaseSuccess("remove manager local runtime profile", null, deleteRuntimeProfileError);
  }
}
