import { LocalRuntimeListResponseSchema } from "../../../../../contracts/local-runtime.js";
import { parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import {
  buildLocalExecution,
  LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS,
  normalizeToolCallCapability,
} from "./config-snippet.js";
import { toLocalRuntimeListItem, type RunnerRow } from "./mappers.js";
import {
  LocalRuntimeAgentRowSchema,
  LocalRuntimeMachineRowSchema,
  LocalRuntimeRoutingRuleListRowSchema,
  RoutingRuleMatchRowSchema,
} from "./row-schemas.js";
import {
  LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX,
  matchValue,
  registrationKindForRule,
  REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS,
} from "./routing-metadata.js";

export async function listRegisteredLocalRuntimesForWorkspace(workspaceId: string) {
  const supabase = getServiceRoleSupabase();

  const { data: rules, error: rulesError } = await supabase
    .from("routing_rule")
    .select("id, model, provider, runner_kind, name")
    .eq("workspace_id", workspaceId)
    .in("runner_kind", [...REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS])
    .like("name", `${LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX}%`);

  if (rulesError) {
    assertSupabaseSuccess("list local runtime routing rules", rules, rulesError);
  }
  const parsedRules = parseSupabaseRows(
    "list local runtime routing rules",
    LocalRuntimeRoutingRuleListRowSchema,
    rules,
  );

  const candidateRules = parsedRules.filter((rule) => {
    if (rule.runner_kind === "local_runtime") return true;
    if (rule.runner_kind === "local_relay" && rule.provider === "openclaw") return true;
    return false;
  });

  if (candidateRules.length === 0) {
    return LocalRuntimeListResponseSchema.parse({
      runtimes: [],
      heartbeatIntervalMs: LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS,
    });
  }

  const ruleIds = candidateRules.map((rule) => rule.id);
  const { data: matches, error: matchesError } = await supabase
    .from("routing_rule_match")
    .select("rule_id, kind, key, value")
    .eq("workspace_id", workspaceId)
    .in("rule_id", ruleIds);

  if (matchesError) {
    assertSupabaseSuccess("list local runtime routing metadata", matches, matchesError);
  }

  const ruleMatches = parseSupabaseRows("list local runtime routing metadata", RoutingRuleMatchRowSchema, matches);
  const matchesByRule = new Map<string, typeof ruleMatches>();
  for (const row of ruleMatches) {
    const current = matchesByRule.get(row.rule_id) ?? [];
    current.push(row);
    matchesByRule.set(row.rule_id, current);
  }

  const machineIdsFromRules = new Map<string, string>();
  for (const rule of candidateRules) {
    const machineId = matchValue(matchesByRule.get(rule.id) ?? [], "local_machine", "id");
    if (machineId) {
      machineIdsFromRules.set(rule.id, machineId);
    }
  }

  const machineIds = Array.from(new Set(machineIdsFromRules.values()));
  const { data: machines, error: machinesError } =
    machineIds.length > 0
      ? await supabase
          .from("local_runtime_machine")
          .select("id, display_name, last_seen_at, revoked_at, runner_kinds, advertised_runner_kinds")
          .eq("workspace_id", workspaceId)
          .is("revoked_at", null)
          .in("id", machineIds)
      : { data: [], error: null };

  if (machinesError) {
    assertSupabaseSuccess("list local runtime machines", machines, machinesError);
  }
  const parsedMachines = parseSupabaseRows("list local runtime machines", LocalRuntimeMachineRowSchema, machines);

  const agentIds = Array.from(
    new Set(ruleMatches.filter((match) => match.kind === "agent_id").map((match) => match.value)),
  );
  const { data: agents, error: agentsError } =
    agentIds.length > 0
      ? await supabase.from("agent").select("id, name").eq("workspace_id", workspaceId).in("id", agentIds)
      : { data: [], error: null };

  if (agentsError) {
    assertSupabaseSuccess("list assigned local runtime agents", agents, agentsError);
  }
  const parsedAgents = parseSupabaseRows("list assigned local runtime agents", LocalRuntimeAgentRowSchema, agents);

  const machinesById = new Map(parsedMachines.map((machine) => [machine.id, machine]));
  const agentsById = new Map(parsedAgents.map((agent) => [agent.id, agent]));

  const runnersByMachine = new Map<string, RunnerRow[]>();
  const workspaceRootByMachine = new Map<string, string>();
  for (const rule of candidateRules) {
    const machineId = machineIdsFromRules.get(rule.id);
    if (!machineId) continue;
    const ruleMatchesForRule = matchesByRule.get(rule.id) ?? [];
    const endpoint = matchValue(ruleMatchesForRule, "local_endpoint", "url");
    if (!endpoint) continue;
    const registrationKind = registrationKindForRule(rule);
    const assignedAgentIds = ruleMatchesForRule
      .filter((match) => match.kind === "agent_id")
      .map((match) => match.value);
    const workspaceRoot = matchValue(ruleMatchesForRule, "local_workspace_root", "path");
    if (workspaceRoot && !workspaceRootByMachine.has(machineId)) {
      workspaceRootByMachine.set(machineId, workspaceRoot);
    }
    const runner: RunnerRow = {
      id: rule.id,
      kind: registrationKind,
      runnerKind: rule.runner_kind === "local_relay" ? "local_relay" : "local_runtime",
      endpoint,
      model: rule.model ?? null,
      provider: rule.provider ?? (registrationKind === "openclaw" ? "openclaw" : "openai_compatible"),
      toolCallCapability:
        registrationKind === "openclaw"
          ? null
          : normalizeToolCallCapability(matchValue(ruleMatchesForRule, "local_model_capability", "tool_call")),
      agents: assignedAgentIds.map((id) => ({
        agentId: id,
        agentName: agentsById.get(id)?.name ?? id,
      })),
    };
    const list = runnersByMachine.get(machineId) ?? [];
    list.push(runner);
    runnersByMachine.set(machineId, list);
  }

  const runtimes = Array.from(runnersByMachine.entries()).map(([machineId, runners]) => {
    const machine = machinesById.get(machineId) ?? null;
    return toLocalRuntimeListItem({
      machineId,
      machineDisplayName: machine?.display_name ?? machineId,
      localExecution: buildLocalExecution({
        machine,
        workspaceRoot: workspaceRootByMachine.get(machineId) ?? null,
      }),
      runners,
    });
  });

  return LocalRuntimeListResponseSchema.parse({
    runtimes,
    heartbeatIntervalMs: LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS,
  });
}
