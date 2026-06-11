import {
  LocalRuntimeConfigResponseSchema,
  LocalRuntimeListItemSchema,
  LocalRuntimeRegistrationResponseSchema,
  LocalRuntimeRunnerSchema,
  type LocalRuntimeRegistrationRunnerKind,
  type LocalRuntimeRunner,
  type LocalRuntimeModel,
  type LocalToolCallCapability,
} from "../../../../../contracts/local-runtime.js";
import {
  buildConfigSnippet,
  buildLaunchCommand,
  buildSetupCommand,
  type ConfigSnippetInput,
} from "./config-snippet.js";
import type { buildLocalExecution } from "./config-snippet.js";

type LocalExecution = ReturnType<typeof buildLocalExecution>;

export function toLocalRuntimeConfigResponse(input: {
  id: string;
  token: string | null;
  tokenAvailable: boolean;
  config: ConfigSnippetInput;
}) {
  return LocalRuntimeConfigResponseSchema.parse({
    id: input.id,
    token: input.token,
    tokenAvailable: input.tokenAvailable,
    configSnippet: buildConfigSnippet(input.config),
    setupCommand: buildSetupCommand(input.config),
    launchCommand: buildLaunchCommand(),
    filename: "runtime.toml",
  });
}

export type RunnerRow = {
  id: string;
  kind: LocalRuntimeRegistrationRunnerKind;
  runnerKind: "local_runtime" | "local_relay";
  endpoint: string | null;
  model: string | null;
  provider: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  models: LocalRuntimeModel[];
  toolCallCapability: LocalToolCallCapability | null;
  agents: Array<{ agentId: string; agentName: string }>;
};

export function toLocalRuntimeRunner(input: RunnerRow): LocalRuntimeRunner {
  return LocalRuntimeRunnerSchema.parse({
    id: input.id,
    kind: input.kind,
    runnerKind: input.runnerKind,
    endpoint: input.endpoint ?? "",
    model: input.model ?? "",
    provider: input.provider ?? defaultProviderFor(input.kind),
    models: input.models,
    lastError: input.lastError,
    lastErrorAt: input.lastErrorAt,
    toolCallCapability: input.toolCallCapability,
    agents: input.agents,
  });
}

export function toLocalRuntimeRegistrationResponse(input: {
  machine: { id: string; displayName: string };
  token: string;
  config: ConfigSnippetInput;
  localExecution: LocalExecution;
  runners: RunnerRow[];
}) {
  return LocalRuntimeRegistrationResponseSchema.parse({
    id: input.machine.id,
    machine: input.machine,
    token: input.token,
    configSnippet: buildConfigSnippet(input.config),
    setupCommand: buildSetupCommand(input.config),
    launchCommand: buildLaunchCommand(),
    localExecution: input.localExecution,
    runners: input.runners.map(toLocalRuntimeRunner),
  });
}

export function toLocalRuntimeListItem(input: {
  machineId: string;
  machineDisplayName: string;
  localExecution: LocalExecution;
  status: "online" | "offline" | "degraded";
  models: LocalRuntimeModel[];
  lastError: string | null;
  runners: RunnerRow[];
}) {
  return LocalRuntimeListItemSchema.parse({
    id: input.machineId,
    machineDisplayName: input.machineDisplayName,
    localExecution: input.localExecution,
    status: input.status,
    models: input.models,
    lastError: input.lastError,
    runners: input.runners.map(toLocalRuntimeRunner),
  });
}

function defaultProviderFor(registrationRunnerKind: LocalRuntimeRegistrationRunnerKind) {
  return registrationRunnerKind === "openclaw" ? "openclaw" : "openai_compatible";
}
