import {
  ContainerExecutionDispatchMetadataSchema,
  NetworkPolicySchema,
  RuntimeDispatchContextSchema,
  type ExecutionProfile,
  type RuntimeDispatchContext,
  type RuntimeExecutionTarget,
  RuntimeWorkspacePolicySchema,
  type RuntimeWorkspacePolicy,
} from "../../../../contracts/execution-profile.js";
import { loadToolExecutionConfig } from "../config.js";
import { ApiRouteError } from "../http.js";
import { findSetupAgentById } from "../repositories/agents.js";
import { getToolsForAgent } from "./agent-tools.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import {
  assertLocalCodingToolsUseRuntimeTarget,
  resolveLocalCodingExecutionTarget,
} from "./local-coding-execution-target.js";
import { resolveContainerDispatchResources } from "./resource-dispatch-resolution.js";

const LOCAL_MODEL_CODING_RUNNER = "local_model_coding";
const PLANNER_RUNNER = "planner";
const LOCAL_RELAY_PROVIDER = "local";
const EXECUTION_TARGET_KINDS = new Set(["local_helper", "container"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalRecordField(
  containerMetadata: Record<string, unknown>,
  field: "artifactStore" | "reviewHandoff",
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(containerMetadata, field)) return undefined;

  const value = containerMetadata[field];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new ApiRouteError(
    422,
    "container_dispatch_metadata_missing",
    "Container execution target requires dispatchMetadata",
    {
      field,
      issue: "must be an object when present",
    },
  );
}

function configuredWorkspacePolicy(agentToolPolicy: unknown): RuntimeWorkspacePolicy | null {
  const toolPolicy = asRecord(agentToolPolicy);
  if (!Object.hasOwn(toolPolicy, "workspacePolicy")) return null;

  const parsed = RuntimeWorkspacePolicySchema.safeParse(toolPolicy.workspacePolicy);
  if (parsed.success) return parsed.data;

  throw new ApiRouteError(422, "invalid_workspace_policy", "Agent workspace policy is invalid", parsed.error.flatten());
}

function defaultWorkspacePolicy(profile: ExecutionProfile): RuntimeWorkspacePolicy {
  return {
    sandbox: profile.capabilities.workspaceWrite ? "workspace_write" : "read_only",
    approvalPolicy: profile.runnerKind === LOCAL_MODEL_CODING_RUNNER ? "on_request" : "never",
  };
}

function buildWorkspacePolicy(profile: ExecutionProfile, agentToolPolicy: unknown): RuntimeWorkspacePolicy {
  return configuredWorkspacePolicy(agentToolPolicy) ?? profile.workspacePolicy ?? defaultWorkspacePolicy(profile);
}

function configuredExecutionTargetKind(agentToolPolicy: unknown): "local_helper" | "container" | null {
  const toolPolicy = asRecord(agentToolPolicy);
  if (!Object.hasOwn(toolPolicy, "executionTarget")) return null;
  const target = asRecord(toolPolicy.executionTarget);
  const kind = typeof target.kind === "string" ? target.kind.trim() : "";
  if (EXECUTION_TARGET_KINDS.has(kind)) {
    return kind as "local_helper" | "container";
  }
  throw new ApiRouteError(422, "invalid_execution_target", "Agent execution target is invalid");
}

async function buildContainerMetadata(input: {
  accessToken: string;
  executionProfile: ExecutionProfile;
  requestBody: unknown;
}) {
  const body = asRecord(input.requestBody);
  const metadata = asRecord(body.dispatchMetadata);
  const limits = asRecord(metadata.limits);
  const artifactRetention = asRecord(metadata.artifactRetention);
  const artifactStore = optionalRecordField(metadata, "artifactStore");
  const reviewHandoff = optionalRecordField(metadata, "reviewHandoff");
  const networkPolicy = asRecord(metadata.networkPolicy);
  const parsedNetworkPolicy = NetworkPolicySchema.safeParse({
    mode: networkPolicy.mode,
    allowedHosts: networkPolicy.allowedHosts,
  });
  if (!parsedNetworkPolicy.success) {
    throw new ApiRouteError(
      422,
      "container_dispatch_metadata_missing",
      "Container execution target requires dispatchMetadata",
      parsedNetworkPolicy.error.flatten(),
    );
  }
  const resources = await resolveContainerDispatchResources({
    accessToken: input.accessToken,
    workspaceId: input.executionProfile.workspaceId,
    agentId: input.executionProfile.agentId,
    dispatchMetadata: metadata,
    fallbackNetworkPolicy: parsedNetworkPolicy.data,
  });

  const parsed = ContainerExecutionDispatchMetadataSchema.safeParse({
    workspaceId: input.executionProfile.workspaceId,
    sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId.trim() : "",
    resources,
    limits: {
      timeoutMs: limits.timeoutMs,
      maxCpuCores: limits.maxCpuCores,
      maxMemoryMb: limits.maxMemoryMb,
      maxDiskMb: limits.maxDiskMb,
    },
    artifactRetention: {
      retainDays: artifactRetention.retainDays,
      storeCommandOutput: artifactRetention.storeCommandOutput,
      storePatchArtifact: artifactRetention.storePatchArtifact,
    },
    artifactStore: artifactStore
      ? {
          type: artifactStore.type,
          bucket: artifactStore.bucket,
          prefix: artifactStore.prefix,
          kmsKeyArn: artifactStore.kmsKeyArn,
        }
      : undefined,
    reviewHandoff: reviewHandoff
      ? {
          enabled: reviewHandoff.enabled,
          mode: reviewHandoff.mode,
          baseBranch: reviewHandoff.baseBranch,
        }
      : undefined,
    networkPolicy: {
      mode: networkPolicy.mode,
      allowedHosts: networkPolicy.allowedHosts,
    },
  });
  if (parsed.success) return parsed.data;

  throw new ApiRouteError(
    422,
    "container_dispatch_metadata_missing",
    "Container execution target requires dispatchMetadata",
    parsed.error.flatten(),
  );
}

async function buildExecutionTarget(input: {
  accessToken: string;
  executionProfile: ExecutionProfile;
  agentToolPolicy: unknown;
  requestBody: unknown;
}): Promise<RuntimeExecutionTarget> {
  const targetKind =
    configuredExecutionTargetKind(input.agentToolPolicy) ?? loadToolExecutionConfig().localCodingExecutionTargetKind;
  if (targetKind === "container") {
    const workspaceRoot = configuredWorkspaceRoot(input.agentToolPolicy);
    if (workspaceRoot) {
      throw new ApiRouteError(
        422,
        "container_local_workspace_root_forbidden",
        "Container execution target cannot use local_workspace_root routing metadata",
      );
    }
    return {
      kind: "container",
      metadata: await buildContainerMetadata({
        accessToken: input.accessToken,
        executionProfile: input.executionProfile,
        requestBody: input.requestBody,
      }),
    };
  }
  return await resolveLocalCodingExecutionTarget({
    workspaceId: input.executionProfile.workspaceId,
    runnerKind:
      input.executionProfile.runnerKind === PLANNER_RUNNER && input.executionProfile.provider === LOCAL_RELAY_PROVIDER
        ? PLANNER_RUNNER
        : LOCAL_MODEL_CODING_RUNNER,
    workspaceRoot: configuredWorkspaceRoot(input.agentToolPolicy),
  });
}

function configuredWorkspaceRoot(agentToolPolicy: unknown): string | null {
  const toolPolicy = asRecord(agentToolPolicy);
  const target = asRecord(toolPolicy.executionTarget);
  const raw = target.workspace_root;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export function shouldAttachRuntimeDispatchContext(profile: ExecutionProfile | null): boolean {
  return (
    profile?.runnerKind === LOCAL_MODEL_CODING_RUNNER ||
    (profile?.runnerKind === PLANNER_RUNNER && profile.provider === LOCAL_RELAY_PROVIDER)
  );
}

export async function buildRuntimeDispatchContext(input: {
  accessToken: string;
  requesterUserId: string;
  agentId: string;
  requestBody: unknown;
}): Promise<RuntimeDispatchContext | null> {
  const resolution = await resolveExecutionProfile({
    accessToken: input.accessToken,
    requesterUserId: input.requesterUserId,
    agentId: input.agentId,
  });

  if (!shouldAttachRuntimeDispatchContext(resolution.profile)) return null;

  if (resolution.missing.length > 0 || !resolution.profile) {
    throw new ApiRouteError(422, "agent_runtime_unconfigured", "Agent runtime is not fully configured", {
      agent_id: input.agentId,
      missing: resolution.missing,
      execution_profile: resolution,
    });
  }

  const agent = await findSetupAgentById(input.accessToken, input.agentId);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }

  const tools = await getToolsForAgent({
    accessToken: input.accessToken,
    userId: input.requesterUserId,
    agentId: input.agentId,
    workspaceId: resolution.profile.workspaceId,
  });
  if (resolution.profile.runnerKind === LOCAL_MODEL_CODING_RUNNER) {
    assertLocalCodingToolsUseRuntimeTarget(tools);
  }
  const executionTarget = await buildExecutionTarget({
    accessToken: input.accessToken,
    executionProfile: resolution.profile,
    agentToolPolicy: agent.tool_policy,
    requestBody: input.requestBody,
  });

  return RuntimeDispatchContextSchema.parse({
    executionProfile: {
      ...resolution.profile,
      toolDefinitions: tools,
    },
    workspacePolicy: buildWorkspacePolicy(resolution.profile, agent.tool_policy),
    executionTarget,
    toolAssignments: tools,
  });
}

export function attachRuntimeDispatchContext(body: unknown, context: RuntimeDispatchContext | null): unknown {
  if (!context) return body;
  const source = asRecord(body);

  return {
    ...source,
    agent_id: context.executionProfile.agentId,
    workspace_id: context.executionProfile.workspaceId,
    execution_profile: context.executionProfile,
    workspace_policy: context.workspacePolicy,
    execution_target: context.executionTarget,
    tool_assignments: context.toolAssignments,
  };
}
