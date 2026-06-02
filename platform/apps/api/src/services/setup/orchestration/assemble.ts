import type { RuntimeExecutionTargetKind } from "../../../../../../contracts/execution-profile.js";
import { loadToolExecutionConfig } from "../../../config.js";
import { ApiRouteError } from "../../../http.js";
import { findSetupAgentById } from "../../../repositories/agents.js";
import { resolveExecutionProfile } from "../../execution-profile-resolver.js";
import { getLiveRuntimeHealth, type LauncherRequest } from "../launcher-orchestration.js";
import { mapGatewayConfig, mapGatewayConfigState, mapSetupAgent, mapSetupEngine } from "../mappers.js";
import { getGatewayConfig, getGatewayConfigState, getLatestEngine } from "../store.js";
import { buildRequirementStatusFromResolution } from "../builders.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function configuredExecutionTargetKind(toolPolicy: unknown): RuntimeExecutionTargetKind | null {
  const policy = asRecord(toolPolicy);
  const executionTarget = asRecord(policy?.executionTarget);
  const kind = executionTarget?.kind;
  return kind === "local_helper" || kind === "container" ? kind : null;
}

function localCodingExecutionTargetKind(
  agent: Awaited<ReturnType<typeof findSetupAgentById>>,
  resolution: Awaited<ReturnType<typeof resolveExecutionProfile>>,
): RuntimeExecutionTargetKind | null {
  if (resolution.profile?.runnerKind !== "local_model_coding") return null;
  return configuredExecutionTargetKind(agent?.tool_policy) ?? loadToolExecutionConfig().localCodingExecutionTargetKind;
}

export async function assembleSetup(
  accessToken: string,
  requesterUserId: string,
  agentId: string,
  launcherRequest?: LauncherRequest,
) {
  const agent = await findSetupAgentById(accessToken, agentId);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  const [gatewayConfig, engine, gatewayConfigState, runtimeHealth, resolution] = await Promise.all([
    getGatewayConfig(accessToken, agentId),
    getLatestEngine(accessToken, agentId),
    getGatewayConfigState(accessToken, agentId),
    getLiveRuntimeHealth(agentId, launcherRequest),
    resolveExecutionProfile({ accessToken, requesterUserId, agentId }),
  ]);

  if (process.env.NODE_ENV === "development") {
    console.log(
      `[setup] assembleSetup agent=${agentId} resolution:`,
      JSON.stringify({
        missing: resolution.missing,
        profile: resolution.profile
          ? {
              runnerKind: resolution.profile.runnerKind,
              provider: resolution.profile.provider,
              model: resolution.profile.model,
            }
          : null,
        source: resolution.source,
      }),
    );
  }

  return {
    agent: mapSetupAgent(agent),
    engine: mapSetupEngine(engine),
    runtimeHealth,
    gatewayConfig: mapGatewayConfig(gatewayConfig),
    gatewayConfigState: mapGatewayConfigState(gatewayConfigState),
    requirements: buildRequirementStatusFromResolution(resolution, {
      includeChecklist: true,
      agentId,
      localCodingExecutionTargetKind: localCodingExecutionTargetKind(agent, resolution),
    }),
  };
}
