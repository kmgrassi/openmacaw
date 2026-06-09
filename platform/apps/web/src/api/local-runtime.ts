import {
  localRuntimeAssignRunnerRoute,
  localRuntimeConfigRoute,
  localRuntimeProbeRoute,
  localRuntimesRoute,
  localRuntimeRotateTokenRoute,
  localRuntimeRoute,
  localRuntimeRunnerProbeRoute,
  localRuntimeUnassignRunnerRoute,
} from "../../../../contracts/routes";
import { workspaceScopedFetch } from "./workspace-scoped-fetch";

// ── Types ──────────────────────────────────────────────────────────────

export type LocalRuntimeAgent = {
  agentId: string;
  agentName: string;
};

export type LocalToolCallCapability =
  | "native_tools"
  | "prompt_fallback"
  | "no_tool_support";

export type LocalRuntimeRegistrationRunnerKind =
  | "openai_compatible"
  | "openclaw";

export type LocalExecutionTarget = {
  machineId: string | null;
  machineDisplayName: string | null;
  helperOnline: boolean;
  lastSeenAt: string | null;
  workspaceRoot: string | null;
  registered: boolean;
  helperVersion: string | null;
  advertisedRunnerKinds: string[];
  advertisedModels: string[];
  runtimeManagedTools: boolean | null;
};

/** One advertised runner attached to a registered helper machine. */
export type LocalRuntimeRunner = {
  /** Routing-rule id — the binding handle for agent assignments. */
  id: string;
  kind: LocalRuntimeRegistrationRunnerKind;
  runnerKind: string;
  endpoint: string;
  model: string;
  provider: string;
  toolCallCapability: LocalToolCallCapability | null;
  agents: LocalRuntimeAgent[];
};

export type LocalRuntime = {
  /** Machine id — identifies the helper registration. */
  id: string;
  machineDisplayName: string;
  localExecution: LocalExecutionTarget;
  runners: LocalRuntimeRunner[];
};

export type LocalRuntimeListResponse = {
  runtimes: LocalRuntime[];
  heartbeatIntervalMs: number;
};

export type OpenAICompatibleRunnerInput = {
  kind: "openai_compatible";
  endpoint: string;
  model: string;
  provider?: string;
  apiKey?: string;
  workspaceRoot?: string;
  toolCallCapability?: LocalToolCallCapability;
};

export type OpenClawRunnerInput = {
  kind: "openclaw";
  endpoint: string;
  apiKey?: string;
};

export type LocalRuntimeRunnerInput =
  | OpenAICompatibleRunnerInput
  | OpenClawRunnerInput;

export type RegisterLocalRuntimeInput = {
  machineDisplayName?: string;
  runners: LocalRuntimeRunnerInput[];
};

export type RegisterLocalRuntimeResponse = {
  id: string;
  machine: {
    id: string;
    displayName: string;
  };
  token: string;
  configSnippet: string;
  setupCommand: string;
  launchCommand: string;
  localExecution: LocalExecutionTarget;
  runners: LocalRuntimeRunner[];
};

export type LocalRuntimeConfigResponse = {
  id: string;
  token: string | null;
  tokenAvailable: boolean;
  configSnippet: string;
  setupCommand: string;
  launchCommand: string;
  filename: "runtime.toml";
};

export type LocalModelProbeResponse = {
  endpoint: string;
  model: string;
  reachable: boolean;
  modelFound: boolean;
  checkedAt: string;
  error: string | null;
};

export type AssignLocalRuntimeInput = {
  agentId: string;
};

export type AssignLocalRuntimeResponse = {
  routingRuleId: string;
  agentId: string;
  model: string;
};

// ── Route constants ────────────────────────────────────────────────────

export const LOCAL_RUNTIME_ROUTES = {
  runtimes: localRuntimesRoute(),
  machine: localRuntimeRoute,
  probe: localRuntimeProbeRoute(),
  runnerProbe: localRuntimeRunnerProbeRoute,
  config: localRuntimeConfigRoute,
  rotateToken: localRuntimeRotateTokenRoute,
  assignRunner: localRuntimeAssignRunnerRoute,
  unassignRunner: localRuntimeUnassignRunnerRoute,
} as const;

// ── API functions ──────────────────────────────────────────────────────

export async function listLocalRuntimes(
  workspaceId: string,
): Promise<LocalRuntimeListResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.runtimes,
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to list local runtimes (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalRuntimeListResponse;
}

export async function registerLocalRuntime(
  workspaceId: string,
  input: RegisterLocalRuntimeInput,
): Promise<RegisterLocalRuntimeResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.runtimes,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to register local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as RegisterLocalRuntimeResponse;
}

export async function removeLocalRuntime(
  workspaceId: string,
  machineId: string,
): Promise<void> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.machine(machineId),
    {
      method: "DELETE",
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to remove local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
}

export async function probeLocalModel(
  workspaceId: string,
  input: { endpoint: string; model: string },
): Promise<LocalModelProbeResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.probe,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to probe local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalModelProbeResponse;
}

export async function probeRegisteredLocalRuntimeRunner(
  workspaceId: string,
  runnerId: string,
): Promise<LocalModelProbeResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.runnerProbe(runnerId),
    { method: "POST" },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to probe local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalModelProbeResponse;
}

export async function getLocalRuntimeConfig(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeConfigResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.config(machineId),
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to regenerate local runtime config (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalRuntimeConfigResponse;
}

export async function rotateLocalRuntimeToken(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeConfigResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.rotateToken(machineId),
    { method: "POST" },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to rotate local runtime token (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalRuntimeConfigResponse;
}

export async function assignLocalRuntimeRunnerToAgent(
  workspaceId: string,
  runnerId: string,
  input: AssignLocalRuntimeInput,
): Promise<AssignLocalRuntimeResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.assignRunner(runnerId),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to assign local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as AssignLocalRuntimeResponse;
}

export async function unassignLocalRuntimeRunnerFromAgent(
  workspaceId: string,
  runnerId: string,
  agentId: string,
): Promise<void> {
  const response = await workspaceScopedFetch(
    workspaceId,
    LOCAL_RUNTIME_ROUTES.unassignRunner(runnerId, agentId),
    {
      method: "DELETE",
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to unassign local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
}
