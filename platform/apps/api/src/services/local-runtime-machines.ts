import {
  LocalRuntimeEventsResponseSchema,
  LocalRuntimeTestDispatchResponseSchema,
  type LocalRuntimeRegistrationRequest,
} from "../../../../contracts/local-runtime.js";
import type { PostgrestError } from "@supabase/supabase-js";
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
import { probeLocalModel, probeRegisteredLocalRuntimeForWorkspace } from "./local-runtime/probing.js";
import {
  LocalRuntimeEventRowSchema,
  LocalRuntimeMachineIdRowSchema,
  RoutingRuleIdRowSchema,
} from "./local-runtime/row-schemas.js";
import {
  defaultMachineDisplayName,
  type InsertedRunner,
  insertedRunnerRows,
  insertRunnerRoutingRules,
} from "./local-runtime/registration.js";
import { createMachineToken, rotateMachineToken } from "./local-runtime/tokens.js";

export { probeLocalModel, probeRegisteredLocalRuntimeForWorkspace };

type RegisterLocalRuntimeInput = {
  workspaceId: string;
  userId: string;
  request: LocalRuntimeRegistrationRequest;
};

type OptionalEventTableClient = {
  from(table: "local_runtime_event"): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        eq(
          column: string,
          value: string,
        ): {
          order(
            column: "created_at",
            options: { ascending: boolean },
          ): {
            limit(limit: number): Promise<{ data: unknown[] | null; error: PostgrestError | null }>;
          };
        };
      };
    };
  };
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

function optionalEventTableMissing(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: string; message?: string };
  return (
    maybeError.code === "42P01" ||
    maybeError.code === "PGRST205" ||
    maybeError.message?.includes("local_runtime_event") === true
  );
}

export async function listLocalRuntimeEventsForWorkspace(workspaceId: string, machineId: string, limit = 50) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const supabase = getServiceRoleSupabase();
  const optionalTables = supabase as unknown as OptionalEventTableClient;
  const { data, error } = await optionalTables
    .from("local_runtime_event")
    .select("id, machine_id, workspace_id, kind, detail, created_at")
    .eq("workspace_id", workspaceId)
    .eq("machine_id", machineId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error && optionalEventTableMissing(error)) {
    return LocalRuntimeEventsResponseSchema.parse({ events: [] });
  }
  if (error) {
    assertSupabaseSuccess("list local runtime events", data, error);
  }

  const rows = parseSupabaseRows("list local runtime events", LocalRuntimeEventRowSchema, data);
  return LocalRuntimeEventsResponseSchema.parse({
    events: rows.map((row) => ({
      id: row.id,
      machineId: row.machine_id,
      workspaceId: row.workspace_id,
      kind: row.kind,
      detail: row.detail ?? {},
      createdAt: row.created_at,
    })),
  });
}

export async function testLocalRuntimeDispatchForWorkspace(workspaceId: string, machineId: string) {
  const list = await listLocalRuntimesForWorkspace(workspaceId);
  const runtime = list.runtimes.find((candidate) => candidate.id === machineId);
  if (!runtime) {
    throw new ApiRouteError(404, "local_runtime_not_found", "Local runtime was not found");
  }

  const helperConnected = runtime.status === "online";
  const runner = runtime.runners.find((candidate) => candidate.kind === "openai_compatible") ?? runtime.runners[0];
  const modelMissingError =
    (runtime.lastError ?? runtime.localExecution.lastError)?.includes("not currently advertised") === true;
  const modelAdvertised =
    !modelMissingError &&
    (!runner?.model ||
      runner.liveModels.length === 0 ||
      runner.liveModels.some((model) => model.model === runner.model));

  if (!helperConnected) {
    return LocalRuntimeTestDispatchResponseSchema.parse({
      helperConnected,
      modelAdvertised,
      dispatchSucceeded: false,
      error: "Helper is offline. Start the local-runtime-helper daemon and wait for a fresh heartbeat.",
    });
  }

  if (!runner) {
    return LocalRuntimeTestDispatchResponseSchema.parse({
      helperConnected,
      modelAdvertised: false,
      dispatchSucceeded: false,
      error: "No runner is registered for this machine.",
    });
  }

  if (!modelAdvertised) {
    return LocalRuntimeTestDispatchResponseSchema.parse({
      helperConnected,
      modelAdvertised: false,
      dispatchSucceeded: false,
      error:
        runtime.lastError ?? runtime.localExecution.lastError ?? "Configured model is not advertised by the helper.",
    });
  }

  if (runner.kind !== "openai_compatible") {
    return LocalRuntimeTestDispatchResponseSchema.parse({
      helperConnected,
      modelAdvertised,
      dispatchSucceeded: true,
      error: null,
    });
  }

  const probe = await probeRegisteredLocalRuntimeForWorkspace(workspaceId, runner.id);
  return LocalRuntimeTestDispatchResponseSchema.parse({
    helperConnected,
    modelAdvertised: probe.modelFound,
    dispatchSucceeded: probe.reachable && probe.modelFound,
    error: probe.reachable && probe.modelFound ? null : (probe.error ?? "Model probe failed."),
  });
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
