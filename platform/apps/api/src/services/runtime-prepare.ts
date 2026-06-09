import { isLocalRunnerKind } from "../../../../contracts/runner-kinds.js";
import type { DefaultAgentRole } from "../../../../contracts/setup.js";
import { ApiRouteError } from "../http.js";
import { findSetupAgentById } from "../repositories/agents.js";
import { resolveLocalCodingExecutionTarget } from "./local-coding-execution-target.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { ensureGatewayConfigExists } from "./ensure-gateway-config.js";
import { resolveRoutedExecutionTargetKind } from "./runtime-dispatch-context.js";
import { buildConfigurationChecklist } from "./setup/builders.js";

function customBackendType(profile: Awaited<ReturnType<typeof resolveExecutionProfile>>["profile"]): string | null {
  if (!profile || profile.role !== "custom") return null;
  return profile.runnerKind || null;
}

function unconfiguredRuntimeDetails(agentId: string, resolution: Awaited<ReturnType<typeof resolveExecutionProfile>>) {
  return {
    agent_id: agentId,
    agent_type: resolution.agent?.role ?? null,
    missing: resolution.missing,
    execution_profile: resolution,
    ...buildConfigurationChecklist(resolution, agentId),
  };
}

export async function assertRuntimePrepareSupported(accessToken: string, requesterUserId: string, agentId: string) {
  const initialResolution = await resolveExecutionProfile({
    accessToken,
    requesterUserId,
    agentId,
    skipCredentialCheck: true,
  });

  if (!initialResolution.agent && initialResolution.missing.includes("agent")) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  // local_model_coding needs a registered helper only when the staged
  // execution-target routing still resolves this workspace to local_helper.
  if (initialResolution.profile?.runnerKind === "local_model_coding") {
    const agent = await findSetupAgentById(accessToken, agentId);
    const executionTargetKind = resolveRoutedExecutionTargetKind({
      agentToolPolicy: agent?.tool_policy ?? {},
      workspaceId: initialResolution.profile.workspaceId,
    });
    if (executionTargetKind === "local_helper") {
      await resolveLocalCodingExecutionTarget({ workspaceId: initialResolution.profile.workspaceId });
    }

    const resolution = await resolveExecutionProfile({ accessToken, requesterUserId, agentId });
    if (resolution.missing.length > 0 || !resolution.profile) {
      throw new ApiRouteError(
        422,
        "agent_runtime_unconfigured",
        "Agent runtime is not fully configured",
        unconfiguredRuntimeDetails(agentId, resolution),
      );
    }

    return {
      agentId: resolution.profile.agentId,
      agentType: resolution.profile.role,
      workspaceId: resolution.profile.workspaceId,
      localRuntime: executionTargetKind === "local_helper",
    };
  }

  // The legacy direct local_runtime transport is dev-only. Production
  // local_relay agents must continue through launcher startup so Runtime can
  // create the orchestrator that owns the helper relay session.
  // Return early so the dashboard shows "Connected" instead of 422.
  if (initialResolution.profile?.runnerKind === "local_runtime") {
    if (process.env.NODE_ENV !== "development") {
      throw new ApiRouteError(
        422,
        "local_runtime_not_supported",
        "Local runtime agents must use the relay transport in production",
      );
    }

    const resolution = await resolveExecutionProfile({ accessToken, requesterUserId, agentId });

    if (resolution.missing.length > 0 || !resolution.profile) {
      throw new ApiRouteError(
        422,
        "agent_runtime_unconfigured",
        "Agent runtime is not fully configured",
        unconfiguredRuntimeDetails(agentId, resolution),
      );
    }

    return {
      agentId: resolution.profile.agentId,
      agentType: resolution.profile.role,
      workspaceId: resolution.profile.workspaceId,
      localRuntime: true,
    };
  }

  if (
    initialResolution.profile &&
    isLocalRunnerKind(initialResolution.profile.runnerKind) &&
    process.env.NODE_ENV === "development"
  ) {
    const resolution = await resolveExecutionProfile({ accessToken, requesterUserId, agentId });

    if (resolution.missing.length > 0 || !resolution.profile) {
      throw new ApiRouteError(
        422,
        "agent_runtime_unconfigured",
        "Agent runtime is not fully configured",
        unconfiguredRuntimeDetails(agentId, resolution),
      );
    }

    return {
      agentId: resolution.profile.agentId,
      agentType: resolution.profile.role,
      workspaceId: resolution.profile.workspaceId,
      localRuntime: true,
    };
  }

  if (initialResolution.agent?.role === "custom") {
    const backendType = customBackendType(initialResolution.profile);

    throw new ApiRouteError(
      422,
      "custom_runtime_unsupported",
      backendType
        ? `Custom backend "${backendType}" is configured, but this platform path can only prepare launcher-managed runtimes.`
        : "Custom agent runtime preparation is not supported until a backend adapter is configured.",
      {
        agent_id: initialResolution.agent.agentId,
        agent_type: initialResolution.agent.role,
        backend_type: backendType,
        execution_profile: initialResolution,
      },
    );
  }

  // Auto-create a default gateway config if one is missing.
  // This handles agents that were configured via the inline credential save flow
  // (Settings > Agents > Credentials) which does not create a gateway config.
  if (
    initialResolution.missing.includes("gateway_config") &&
    initialResolution.agent &&
    (initialResolution.agent.role === "planning" || initialResolution.agent.role === "coding")
  ) {
    await ensureGatewayConfigExists({
      agentId,
      role: initialResolution.agent.role as DefaultAgentRole,
    });
  }

  const resolution = await resolveExecutionProfile({ accessToken, requesterUserId, agentId });

  if (resolution.missing.length > 0 || !resolution.profile) {
    throw new ApiRouteError(
      422,
      "agent_runtime_unconfigured",
      "Agent runtime is not fully configured",
      unconfiguredRuntimeDetails(agentId, resolution),
    );
  }

  return {
    agentId: resolution.profile.agentId,
    agentType: resolution.profile.role,
    workspaceId: resolution.profile.workspaceId,
    localRuntime: false,
  };
}
