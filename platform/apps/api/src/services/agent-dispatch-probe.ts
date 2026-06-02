import {
  AgentDispatchDryRunResponseSchema,
  AgentDispatchLiveResponseSchema,
  type AgentDispatchDryRunResponse,
  type AgentDispatchLiveResponse,
} from "../../../../contracts/agent-dispatch-probe.js";
import type { ExecutionProfile, RuntimeDispatchContext } from "../../../../contracts/execution-profile.js";
import { ApiRouteError } from "../http.js";
import { findSetupAgentById } from "../repositories/agents.js";
import type { LauncherClient } from "./launcher.js";
import { getToolsForAgent } from "./agent-tools.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import {
  attachRuntimeDispatchContext,
  buildRuntimeDispatchContext,
  shouldAttachRuntimeDispatchContext,
} from "./runtime-dispatch-context.js";

type BuildDispatchDryRunInput = {
  accessToken: string;
  requesterUserId: string;
  agentId: string;
  workspaceId: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function credentialSummary(profile: ExecutionProfile) {
  return {
    resolved: Boolean(profile.credentialRef),
    refType: profile.credentialRef?.type ?? null,
  };
}

function profileSummary(profile: ExecutionProfile) {
  return {
    agentId: profile.agentId,
    workspaceId: profile.workspaceId,
    role: profile.role,
    runnerKind: profile.runnerKind,
    provider: profile.provider,
    model: profile.model,
    toolProfile: profile.toolProfile,
    credential: credentialSummary(profile),
    capabilities: profile.capabilities,
  };
}

function runtimePayload(agentId: string, workspaceId: string, context: RuntimeDispatchContext | null) {
  const launchBody = { agent_id: agentId, workspace_id: workspaceId };

  return {
    body: attachRuntimeDispatchContext(launchBody, context) as Record<string, unknown>,
  };
}

function runtimeReportedConfig(config: unknown) {
  const root = asRecord(config);
  const executionProfile = asRecord(root.executionProfile ?? root.execution_profile);
  const profile = asRecord(root.profile);
  const dispatch = asRecord(root.dispatch);

  return {
    runnerKind: firstString(
      executionProfile.runnerKind,
      executionProfile.runner_kind,
      profile.runnerKind,
      profile.runner_kind,
      dispatch.runnerKind,
      dispatch.runner_kind,
      root.runnerKind,
      root.runner_kind,
    ),
    provider: firstString(executionProfile.provider, profile.provider, dispatch.provider, root.provider),
    model: firstString(executionProfile.model, profile.model, dispatch.model, root.model),
    toolProfile: firstString(
      executionProfile.toolProfile,
      executionProfile.tool_profile,
      profile.toolProfile,
      profile.tool_profile,
      dispatch.toolProfile,
      dispatch.tool_profile,
      root.toolProfile,
      root.tool_profile,
    ),
  };
}

function compareConfig(
  platform: AgentDispatchDryRunResponse["platform"]["profile"],
  runtime: ReturnType<typeof runtimeReportedConfig>,
) {
  return [
    { field: "runnerKind" as const, platformValue: platform.runnerKind, runtimeValue: runtime.runnerKind },
    { field: "provider" as const, platformValue: platform.provider, runtimeValue: runtime.provider },
    { field: "model" as const, platformValue: platform.model, runtimeValue: runtime.model },
    { field: "toolProfile" as const, platformValue: platform.toolProfile, runtimeValue: runtime.toolProfile },
  ].map((comparison) => ({
    ...comparison,
    matches: comparison.platformValue === comparison.runtimeValue,
  }));
}

export async function buildAgentDispatchDryRun(input: BuildDispatchDryRunInput): Promise<AgentDispatchDryRunResponse> {
  const resolution = await resolveExecutionProfile({
    accessToken: input.accessToken,
    requesterUserId: input.requesterUserId,
    agentId: input.agentId,
  });

  if (resolution.missing.length > 0 || !resolution.profile) {
    throw new ApiRouteError(422, "agent_runtime_unconfigured", "Agent runtime is not fully configured", {
      agentId: input.agentId,
      missing: resolution.missing,
      executionProfile: resolution,
    });
  }

  if (resolution.profile.workspaceId !== input.workspaceId) {
    throw new ApiRouteError(400, "workspace_mismatch", "Agent does not belong to the requested workspace", {
      agentId: input.agentId,
      requestedWorkspaceId: input.workspaceId,
      agentWorkspaceId: resolution.profile.workspaceId,
    });
  }

  if (!(await findSetupAgentById(input.accessToken, input.agentId))) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  const tools = await getToolsForAgent({
    accessToken: input.accessToken,
    userId: input.requesterUserId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
  });
  const context = shouldAttachRuntimeDispatchContext(resolution.profile)
    ? await buildRuntimeDispatchContext({
        accessToken: input.accessToken,
        requesterUserId: input.requesterUserId,
        agentId: input.agentId,
        requestBody: { agent_id: input.agentId, workspace_id: input.workspaceId },
      })
    : null;
  const response = {
    status: "ready" as const,
    mode: "dryRun" as const,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    resolvedAt: new Date().toISOString(),
    platform: {
      profile: profileSummary(resolution.profile),
      source: resolution.source,
      toolDefinitions: tools,
      workspacePolicy: context?.workspacePolicy ?? null,
      executionTarget: context?.executionTarget ?? null,
    },
    runtimePayload: runtimePayload(input.agentId, input.workspaceId, context),
  };

  return AgentDispatchDryRunResponseSchema.parse(response);
}

export async function runAgentDispatchLive(
  input: BuildDispatchDryRunInput & { launcherClient: LauncherClient },
): Promise<AgentDispatchLiveResponse> {
  const dryRun = await buildAgentDispatchDryRun(input);
  const result = await input.launcherClient.startAgent(input.agentId, dryRun.runtimePayload.body);
  const runtimeState = result.data.data;
  const runtimeReported = runtimeReportedConfig(runtimeState.config);
  const comparisons = compareConfig(dryRun.platform.profile, runtimeReported);
  const status = comparisons.every((comparison) => comparison.matches) ? "matched" : "mismatch";

  const response = {
    status,
    mode: "live" as const,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    resolvedAt: new Date().toISOString(),
    runtimeTarget: {
      id: runtimeState.id,
      port: runtimeState.port,
      status: runtimeState.status,
      reused: runtimeState.reused,
      agentId: runtimeState.agent_id ?? null,
      workspaceId: runtimeState.workspace_id ?? null,
    },
    firstObservedRuntimeState: runtimeState,
    platform: dryRun.platform,
    runtimeReported,
    comparisons,
  };

  return AgentDispatchLiveResponseSchema.parse(response);
}
