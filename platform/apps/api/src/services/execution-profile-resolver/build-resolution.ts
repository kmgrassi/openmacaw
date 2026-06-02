import { ExecutionProviderSchema } from "../../../../../contracts/execution-profile.js";
import type {
  AgentRole,
  ExecutionProfile,
  ExecutionProfileMissingRequirement,
  ExecutionProfileResolution,
} from "../../../../../contracts/execution-profile.js";
import {
  capabilitiesForRunnerKind,
  isCredentiallessRunnerKind,
  isLocalCodingRunnerKind,
} from "../../../../../contracts/runner-kinds.js";
import type { RunnerKind } from "../../../../../contracts/runner-kinds.js";
import { toolProfileForAgentType } from "../tool-bundles.js";
import { isCredentiallessManagerProfile, isCredentiallessPlannerProfile } from "./credential-state.js";
import type { AgentProfileRow } from "./types.js";

export function buildResolution(input: {
  agent: AgentProfileRow;
  role: AgentRole;
  runnerKind: RunnerKind | null;
  provider: string | null;
  model: string | null;
  credentialRef: ExecutionProfile["credentialRef"];
  hasCredential?: boolean;
  routingRuleId: string | null;
  credentialAlias: string | null;
  fallbackUsed: boolean;
  legacyGatewayConfigUsed: boolean;
}): ExecutionProfileResolution {
  const missing: ExecutionProfileMissingRequirement[] = [];
  const parsedProvider = input.provider ? ExecutionProviderSchema.safeParse(input.provider) : null;
  const provider = parsedProvider?.success ? parsedProvider.data : null;
  const hasCredential = input.hasCredential ?? Boolean(input.credentialRef);
  const credentiallessRunner = input.runnerKind ? isCredentiallessRunnerKind(input.runnerKind) : false;
  const credentiallessProfile =
    credentiallessRunner || isCredentiallessManagerProfile(input) || isCredentiallessPlannerProfile(input);
  const localCodingProfile = input.runnerKind ? isLocalCodingRunnerKind(input.runnerKind) : false;
  if (!input.runnerKind) missing.push("runner");
  if (!provider) missing.push("provider");
  if (!input.model) missing.push("model");
  if (!hasCredential && !credentiallessProfile) missing.push("credential");
  if (input.fallbackUsed && !input.legacyGatewayConfigUsed) missing.push("gateway_config");
  if (!input.routingRuleId && !input.fallbackUsed) missing.push("route");

  return {
    agent: {
      agentId: input.agent.id,
      workspaceId: input.agent.workspace_id,
      role: input.role,
    },
    profile:
      input.runnerKind && provider && input.model
        ? {
            agentId: input.agent.id,
            workspaceId: input.agent.workspace_id,
            role: input.role,
            runnerKind: input.runnerKind,
            provider,
            model: input.model,
            credentialRef: input.credentialRef,
            toolProfile: toolProfileForAgentType(input.role),
            workspacePolicy: localCodingProfile
              ? { sandbox: "workspace_write", approvalPolicy: "on_request" }
              : undefined,
            capabilityRequirements: localCodingProfile ? { toolCalls: true, jsonMode: true } : undefined,
            capabilities: capabilitiesForRunnerKind(input.runnerKind, input.role),
          }
        : null,
    missing,
    source: {
      routingRuleId: input.routingRuleId,
      credentialAlias: input.credentialAlias,
      fallbackUsed: input.fallbackUsed,
      legacyGatewayConfigUsed: input.legacyGatewayConfigUsed,
    },
  };
}
