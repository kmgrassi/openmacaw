import { join, resolve } from "node:path";

const DEFAULT_SINCE_MS = 10 * 60 * 1000;

export function parseArgs(rawArgs) {
  const parsed = {
    agentId: null,
    workspaceId: null,
    requestId: null,
    messageId: null,
    toolCallId: null,
    runId: null,
    sinceMs: DEFAULT_SINCE_MS,
    apiBaseUrl: process.env.PLATFORM_API_BASE_URL ?? "http://127.0.0.1:3100",
    token: process.env.PLATFORM_API_TOKEN ?? process.env.API_AUTH_TOKEN ?? null,
    runtimeLogPaths: [],
    artifactsDir: null,
    rootDir: process.cwd(),
    json: false,
    help: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const value = rawArgs[index + 1];

    if (arg === "--") continue;
    else if (arg === "--agent-id") {
      parsed.agentId = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--agent-id=")) {
      parsed.agentId = arg.slice("--agent-id=".length);
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--workspace-id=")) {
      parsed.workspaceId = arg.slice("--workspace-id=".length);
    } else if (arg === "--request-id") {
      parsed.requestId = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--request-id=")) {
      parsed.requestId = arg.slice("--request-id=".length);
    } else if (arg === "--message-id") {
      parsed.messageId = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--message-id=")) {
      parsed.messageId = arg.slice("--message-id=".length);
    } else if (arg === "--tool-call-id") {
      parsed.toolCallId = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--tool-call-id=")) {
      parsed.toolCallId = arg.slice("--tool-call-id=".length);
    } else if (arg === "--run-id") {
      parsed.runId = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--run-id=")) {
      parsed.runId = arg.slice("--run-id=".length);
    } else if (arg === "--since") {
      parsed.sinceMs = parseDuration(requireValue(arg, value));
      index += 1;
    } else if (arg?.startsWith("--since=")) {
      parsed.sinceMs = parseDuration(arg.slice("--since=".length));
    } else if (arg === "--api-base-url") {
      parsed.apiBaseUrl = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--api-base-url=")) {
      parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    } else if (arg === "--api-token") {
      parsed.token = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--api-token=")) {
      parsed.token = arg.slice("--api-token=".length);
    } else if (arg === "--runtime-log") {
      parsed.runtimeLogPaths.push(requireValue(arg, value));
      index += 1;
    } else if (arg?.startsWith("--runtime-log=")) {
      parsed.runtimeLogPaths.push(arg.slice("--runtime-log=".length));
    } else if (arg === "--artifacts-dir") {
      parsed.artifactsDir = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--artifacts-dir=")) {
      parsed.artifactsDir = arg.slice("--artifacts-dir=".length);
    } else if (arg === "--root-dir") {
      parsed.rootDir = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--root-dir=")) {
      parsed.rootDir = arg.slice("--root-dir=".length);
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.rootDir = resolve(parsed.rootDir);
  parsed.apiBaseUrl = parsed.apiBaseUrl.replace(/\/$/, "");
  parsed.artifactsDir = parsed.artifactsDir
    ? resolve(parsed.rootDir, parsed.artifactsDir)
    : join(parsed.rootDir, ".run-artifacts");
  parsed.runtimeLogPaths = parsed.runtimeLogPaths.map((item) =>
    resolve(parsed.rootDir, item),
  );

  for (const key of [
    "agentId",
    "workspaceId",
    "requestId",
    "messageId",
    "toolCallId",
    "runId",
  ]) {
    parsed[key] = parsed[key]?.trim() || null;
  }

  return parsed;
}

export function hasAnyIdentifier(input) {
  return Boolean(
    input.agentId ||
      input.requestId ||
      input.messageId ||
      input.toolCallId ||
      input.runId,
  );
}

export function identifierMap(input) {
  return compact({
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    runId: input.runId,
  });
}

export function printHelp() {
  console.log(`Usage: pnpm run trace:agent -- [options]

Options:
  --agent-id <id>          Trace evidence for an agent
  --workspace-id <id>      Workspace context for diagnostics and dashboard checks
  --request-id <id>        Require matching request_id evidence
  --message-id <id>        Look for a persisted/message evidence id in logs and artifacts
  --tool-call-id <id>      Look for tool-call evidence in logs, dashboard rows, and artifacts
  --run-id <id>            Look for a runtime/dashboard run id
  --since <duration>       Time window to read, for example 10m, 2h, 45s. Default: 10m
  --api-base-url <url>     Platform API base URL (default: http://127.0.0.1:3100)
  --api-token <token>      Bearer token for authenticated dashboard checks
  --runtime-log <path>     Runtime log path to search. Repeatable
  --artifacts-dir <path>   Browser artifact root (default: .run-artifacts)
  --json                   Print machine-readable output
`);
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseDuration(value) {
  const match = /^(\d+)(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid --since value "${value}". Use values like 10m, 2h, or 45s.`,
    );
  }
  const amount = Number(match[1]);
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * multipliers[(match[2] ?? "ms").toLowerCase()];
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null && item !== "",
    ),
  );
}
