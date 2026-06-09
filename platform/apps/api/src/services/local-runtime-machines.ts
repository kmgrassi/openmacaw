import type { LocalRuntimeRegistrationRequest } from "../../../../contracts/local-runtime.js";
import { ApiRouteError } from "../http.js";
import { parseNullableSupabaseRow, parseSupabaseRows } from "../lib/supabase-row-parsers.js";
import { assertSupabaseSuccess } from "../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { buildLocalExecution } from "./local-runtime/config-snippet.js";
import {
  buildLocalRuntimeConfigResponse,
  buildRegistrationConfig,
  sharedWorkspaceRootFromRegistration,
} from "./local-runtime/config-response.js";
import { toLocalRuntimeRegistrationResponse, type RunnerRow } from "./local-runtime/mappers.js";
import { listRegisteredLocalRuntimesForWorkspace } from "./local-runtime/listing.js";
import {
  deleteLocalRuntimeMachine,
  ensureLocalMachineMatchesForWorkspace,
  ensureLocalRuntimeMachineForRegistration,
  machineRunnerKindsForRegistration,
  revokeLocalRuntimeMachines,
  unreferencedMachineIdsAfterLocalRuntimeDelete,
} from "./local-runtime/machines.js";
import { getLocalRuntimeMachineDetails } from "./local-runtime/routing-metadata.js";
import { LocalRuntimeMachineIdRowSchema, RoutingRuleIdRowSchema } from "./local-runtime/row-schemas.js";
import {
  defaultMachineDisplayName,
  type InsertedRunner,
  insertedRunnerRows,
  insertRunnerRoutingRules,
} from "./local-runtime/registration.js";
import { createMachineToken, rotateMachineToken } from "./local-runtime/tokens.js";

export { probeLocalModel, probeRegisteredLocalRuntimeForWorkspace } from "./local-runtime/probing.js";

type RegisterLocalRuntimeInput = {
  workspaceId: string;
  userId: string;
  request: LocalRuntimeRegistrationRequest;
};

export async function registerLocalRuntimeForWorkspace({ workspaceId, userId, request }: RegisterLocalRuntimeInput) {
  const supabase = getServiceRoleSupabase();
  const displayName = request.machineDisplayName?.trim() || defaultMachineDisplayName(request.runners);
  const registrationKinds = request.runners.map((runner) => runner.kind);
  const machineRunnerKinds = machineRunnerKindsForRegistration(registrationKinds);

  const { machineId, machineDisplayName, createdMachine } = await ensureLocalRuntimeMachineForRegistration({
    supabase,
    workspaceId,
    userId,
    displayName,
    runnerKinds: machineRunnerKinds,
  });

  const { plaintextToken, error: tokenError } = await createMachineToken({ supabase, machineId, workspaceId });

  if (tokenError) {
    if (createdMachine) {
      await deleteLocalRuntimeMachine({ supabase, machineId });
    }
    assertSupabaseSuccess("create machine token for local runtime", null, tokenError);
  }

  let inserted: InsertedRunner[];
  try {
    inserted = await insertRunnerRoutingRules({
      supabase,
      workspaceId,
      machineId,
      runners: request.runners,
    });
  } catch (error) {
    await supabase.from("local_runtime_token").delete().eq("machine_id", machineId);
    if (createdMachine) {
      await supabase.from("local_runtime_machine").delete().eq("id", machineId);
    }
    throw error;
  }

  await ensureLocalMachineMatchesForWorkspace({ supabase, workspaceId, machineId });

  const sharedWorkspaceRoot = sharedWorkspaceRootFromRegistration(request.runners);

  const runners: RunnerRow[] = insertedRunnerRows(inserted);

  return toLocalRuntimeRegistrationResponse({
    machine: { id: machineId, displayName: machineDisplayName },
    token: plaintextToken,
    config: buildRegistrationConfig({
      displayName,
      workspaceRoot: sharedWorkspaceRoot,
      workspaceId,
      token: plaintextToken,
      runners: request.runners,
    }),
    localExecution: buildLocalExecution({
      machine: {
        id: machineId,
        display_name: machineDisplayName,
        last_seen_at: null,
        revoked_at: null,
        runner_kinds: machineRunnerKinds,
        advertised_runner_kinds: [],
      },
      workspaceRoot: sharedWorkspaceRoot,
    }),
    runners,
  });
}

export async function getLocalRuntimeConfigForWorkspace(workspaceId: string, machineId: string) {
  const details = await getLocalRuntimeMachineDetails(workspaceId, machineId);
  return buildLocalRuntimeConfigResponse({
    workspaceId,
    machineId: details.machineId,
    machineDisplayName: details.machineDisplayName,
    workspaceRoot: details.workspaceRoot,
    token: null,
    tokenAvailable: false,
    runners: details.runners,
  });
}

export async function rotateLocalRuntimeTokenForWorkspace(workspaceId: string, machineId: string) {
  const details = await getLocalRuntimeMachineDetails(workspaceId, machineId);
  const supabase = getServiceRoleSupabase();
  const plaintextToken = await rotateMachineToken({ supabase, workspaceId, machineId: details.machineId });

  return buildLocalRuntimeConfigResponse({
    workspaceId,
    machineId: details.machineId,
    machineDisplayName: details.machineDisplayName,
    workspaceRoot: details.workspaceRoot,
    token: plaintextToken,
    tokenAvailable: true,
    runners: details.runners,
  });
}

export async function listLocalRuntimesForWorkspace(workspaceId: string) {
  return listRegisteredLocalRuntimesForWorkspace(workspaceId);
}

export async function deleteLocalRuntimeForWorkspace(workspaceId: string, machineId: string) {
  const supabase = getServiceRoleSupabase();

  const { data: machineRow, error: machineError } = await supabase
    .from("local_runtime_machine")
    .select("id")
    .eq("id", machineId)
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null)
    .single();

  if (machineError || !machineRow) {
    throw new ApiRouteError(404, "local_runtime_not_found", "Local runtime was not found");
  }
  parseNullableSupabaseRow("read local runtime machine for deletion", LocalRuntimeMachineIdRowSchema, machineRow);

  const { data: machineMatches, error: machineMatchError } = await supabase
    .from("routing_rule_match")
    .select("rule_id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "local_machine")
    .eq("key", "id")
    .eq("value", machineId);

  if (machineMatchError) {
    assertSupabaseSuccess("read routing rules for local runtime machine deletion", machineMatches, machineMatchError);
  }

  const parsedMachineMatches = parseSupabaseRows(
    "read routing rules for local runtime machine deletion",
    RoutingRuleIdRowSchema,
    machineMatches,
  );
  const ruleIds = Array.from(new Set(parsedMachineMatches.map((row) => row.rule_id)));

  if (ruleIds.length > 0) {
    const { error: deleteMatchError } = await supabase.from("routing_rule_match").delete().in("rule_id", ruleIds);
    if (deleteMatchError) {
      assertSupabaseSuccess("delete local runtime routing matches", null, deleteMatchError);
    }
    const { error: deleteRuleError } = await supabase.from("routing_rule").delete().in("id", ruleIds);
    if (deleteRuleError) {
      assertSupabaseSuccess("delete local runtime routing rules", null, deleteRuleError);
    }
  }

  const unreferencedMachineIds = await unreferencedMachineIdsAfterLocalRuntimeDelete({
    supabase,
    workspaceId,
    machineIds: [machineId],
  });

  await revokeLocalRuntimeMachines({
    supabase,
    workspaceId,
    machineIds: unreferencedMachineIds,
  });
}
