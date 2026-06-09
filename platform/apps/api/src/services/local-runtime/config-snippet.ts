import type {
  LocalRuntimeRegistrationRunnerKind,
  LocalToolCallCapability,
} from "../../../../../contracts/local-runtime.js";
import type { Tables } from "@kmgrassi/supabase-schema";

export const LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS = 30_000;
const HELPER_ONLINE_WINDOW_MS = LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS * 2;

export type LocalRuntimeMachineRow = Pick<
  Tables<"local_runtime_machine">,
  "id" | "display_name" | "last_seen_at" | "revoked_at" | "runner_kinds"
>;

export function helperOnline(lastSeenAt: string | null | undefined) {
  if (!lastSeenAt) return false;
  const timestamp = Date.parse(lastSeenAt);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp <= HELPER_ONLINE_WINDOW_MS;
}

export function normalizeToolCallCapability(value: string | null): LocalToolCallCapability {
  if (value === "prompt_fallback" || value === "no_tool_support") return value;
  return "native_tools";
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

export function buildLaunchCommand() {
  return "local-runtime-helper start";
}

export type RunnerSnippet =
  | {
      kind: "openai_compatible";
      endpoint: string;
      apiKey: string | null;
      model: string;
      toolCallCapability: LocalToolCallCapability;
    }
  | {
      kind: "openclaw";
      endpoint: string;
      apiKey: string | null;
    };

export type ConfigSnippetInput = {
  displayName: string;
  /** Workspace root applies to the openai_compatible runner only; rendered on the [machine] table. */
  workspaceRoot: string | null;
  runtimeEndpoint: string;
  workspaceId: string;
  token: string;
  runners: RunnerSnippet[];
};

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSetupCommand(input: ConfigSnippetInput) {
  const args = [
    "register",
    "--endpoint",
    input.runtimeEndpoint,
    "--workspace",
    input.workspaceId,
    "--name",
    input.displayName,
    "--token",
    input.token,
    "--force",
  ];
  if (input.workspaceRoot) {
    args.push("--workspace-root", input.workspaceRoot);
  }
  for (const runner of input.runners) {
    if (runner.kind === "openai_compatible") {
      args.push(
        "--openai-compatible-endpoint",
        runner.endpoint,
        "--openai-compatible-model",
        runner.model,
        "--tool-call-capability",
        runner.toolCallCapability,
      );
      if (runner.apiKey) args.push("--openai-compatible-api-key", runner.apiKey);
    } else {
      args.push("--openclaw-endpoint", runner.endpoint);
      if (runner.apiKey) args.push("--openclaw-api-key", runner.apiKey);
    }
  }

  const helperArgs = args.map(shellQuote).join(" ");
  return [
    'GOBIN="$(go env GOBIN)"',
    'GOPATH="$(go env GOPATH)"',
    'HELPER_BIN="${GOBIN:-$GOPATH/bin}/local-runtime-helper"',
    "cd local-runtime-helper",
    'go install ./cmd/local-runtime-helper',
    `"$HELPER_BIN" ${helperArgs}`,
    '"$HELPER_BIN" start',
  ].join(" && ");
}

export function buildConfigSnippet(input: ConfigSnippetInput) {
  const header = [
    "[machine]",
    `display_name = ${tomlString(input.displayName)}`,
    input.workspaceRoot ? `workspace_root = ${tomlString(input.workspaceRoot)}` : null,
    "",
    "[cloud]",
    `endpoint = ${tomlString(input.runtimeEndpoint)}`,
    `workspace_id = ${tomlString(input.workspaceId)}`,
    `token = ${tomlString(input.token)}`,
  ];

  const runnerStanzas = input.runners.flatMap((runner) => {
    if (runner.kind === "openclaw") {
      return [
        "",
        "[runner.openclaw]",
        `endpoint = ${tomlString(runner.endpoint)}`,
        runner.apiKey ? `api_key = ${tomlString(runner.apiKey)}` : null,
      ];
    }
    return [
      "",
      "[runner.openai_compatible]",
      `endpoint = ${tomlString(runner.endpoint)}`,
      `model = ${tomlString(runner.model)}`,
      runner.apiKey ? `api_key = ${tomlString(runner.apiKey)}` : null,
      `tool_call_capability = ${tomlString(runner.toolCallCapability)}`,
    ];
  });

  return [...header, ...runnerStanzas].filter((line): line is string => line !== null).join("\n");
}

export function buildLocalExecution(input: { machine: LocalRuntimeMachineRow | null; workspaceRoot: string | null }) {
  return {
    machineId: input.machine?.id ?? null,
    machineDisplayName: input.machine?.display_name ?? null,
    helperOnline: helperOnline(input.machine?.last_seen_at),
    lastSeenAt: input.machine?.last_seen_at ?? null,
    workspaceRoot: input.workspaceRoot,
    registered: Boolean(input.machine && input.workspaceRoot),
    helperVersion: null,
    advertisedRunnerKinds: input.machine?.runner_kinds ?? [],
    advertisedModels: [],
    runtimeManagedTools: null,
  };
}

export type { LocalRuntimeRegistrationRunnerKind };
