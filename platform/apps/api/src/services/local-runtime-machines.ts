import type { LocalRuntimeRegistrationRequest, LocalRuntimeRunnerInput } from "../../../../contracts/local-runtime.js";
import { ApiRouteError } from "../http.js";
import { parseNullableSupabaseRow, parseSupabaseRows } from "../lib/supabase-row-parsers.js";
import { assertSupabaseSuccess } from "../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { buildLocalExecution } from "./local-runtime/config-snippet.js";
import { toLocalRuntimeRegistrationResponse, type RunnerRow } from "./local-runtime/mappers.js";
import { toLocalRuntimeConfigResponse } from "./local-runtime/mappers.js";
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
  buildRunnerSnippets,
  defaultMachineDisplayName,
  type InsertedRunner,
  insertedRunnerRows,
  insertRunnerRoutingRules,
  runnerSnippetFromDetails,
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

  const runtimeEndpoint = process.env.LOCAL_RELAY_WS_URL ?? "ws://127.0.0.1:4000";
  const sharedWorkspaceRoot =
    request.runners
      .find(
        (runner): runner is Extract<LocalRuntimeRunnerInput, { kind: "openai_compatible" }> =>
          runner.kind === "openai_compatible" && Boolean(runner.workspaceRoot?.trim()),
      )
      ?.workspaceRoot?.trim() ?? null;

  const runners: RunnerRow[] = insertedRunnerRows(inserted);

  return toLocalRuntimeRegistrationResponse({
    machine: { id: machineId, displayName: machineDisplayName },
    token: plaintextToken,
    config: {
      displayName,
      workspaceRoot: sharedWorkspaceRoot,
      runtimeEndpoint,
      workspaceId,
      token: plaintextToken,
      runners: buildRunnerSnippets(request.runners),
    },
    localExecution: buildLocalExecution({
      machine: {
        id: machineId,
        display_name: machineDisplayName,
        last_seen_at: null,
        revoked_at: null,
        runner_kinds: machineRunnerKinds,
      },
      workspaceRoot: sharedWorkspaceRoot,
    }),
    runners,
  });
}

export async function getLocalRuntimeConfigForWorkspace(workspaceId: string, machineId: string) {
  const details = await getLocalRuntimeMachineDetails(workspaceId, machineId);
  const runtimeEndpoint = process.env.LOCAL_RELAY_WS_URL ?? "ws://127.0.0.1:4000";
  return toLocalRuntimeConfigResponse({
    id: details.machineId,
    token: null,
    tokenAvailable: false,
    config: {
      displayName: details.machineDisplayName,
      workspaceRoot: details.workspaceRoot,
      runtimeEndpoint,
      workspaceId,
      token: "<rotate-token-to-generate-a-new-value>",
      runners: details.runners.map((runner) => runnerSnippetFromDetails(runner)),
    },
  });
}

export async function rotateLocalRuntimeTokenForWorkspace(workspaceId: string, machineId: string) {
  const details = await getLocalRuntimeMachineDetails(workspaceId, machineId);
  const supabase = getServiceRoleSupabase();
  const plaintextToken = await rotateMachineToken({ supabase, workspaceId, machineId: details.machineId });

  const runtimeEndpoint = process.env.LOCAL_RELAY_WS_URL ?? "ws://127.0.0.1:4000";
  return toLocalRuntimeConfigResponse({
    id: details.machineId,
    token: plaintextToken,
    tokenAvailable: true,
    config: {
      displayName: details.machineDisplayName,
      workspaceRoot: details.workspaceRoot,
      runtimeEndpoint,
      workspaceId,
      token: plaintextToken,
      runners: details.runners.map((runner) => runnerSnippetFromDetails(runner)),
    },
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
