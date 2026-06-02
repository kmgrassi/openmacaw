#!/usr/bin/env node

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { probeHttpJson } from "./lib/platform-probes.mjs";

const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_SINCE_MS = 10 * 60 * 1000;
const MAX_EVIDENCE = 5;
const HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(
    `trace:agent failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  if (!hasAnyIdentifier(args)) {
    throw new Error(
      "Provide at least one of --agent-id, --request-id, --message-id, --tool-call-id, or --run-id",
    );
  }

  const sinceDate = new Date(Date.now() - args.sinceMs);
  const identifiers = identifierMap(args);
  const platformLogs = await readLogFiles(
    platformLogFiles(args.rootDir),
    sinceDate,
    identifiers,
  );
  const runtimeLogs = await readLogFiles(
    runtimeLogFiles(args),
    sinceDate,
    identifiers,
  );
  const apiTrace = summarizeLogLayer(
    "api",
    platformLogs.filter((record) => record.layer === "api"),
    identifiers,
  );
  const runtimeBoundaryTrace = summarizeRuntimeBoundary(
    platformLogs,
    identifiers,
  );
  const runtimeTrace = summarizeRuntimeLogs(
    runtimeLogs,
    identifiers,
    args.runId,
  );
  const diagnosticTrace = await summarizeDiagnostic(args);
  const dashboardTrace = await summarizeDashboard(args);
  const artifactTrace = await summarizeBrowserArtifacts(args, identifiers);

  const checks = [
    apiTrace,
    runtimeBoundaryTrace,
    runtimeTrace,
    diagnosticTrace,
    dashboardTrace,
    artifactTrace,
  ];
  const result = {
    status: checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "ok",
    since: sinceDate.toISOString(),
    identifiers,
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTrace(result);
  }

  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

function parseArgs(rawArgs) {
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

    if (arg === "--") {
      continue;
    } else if (arg === "--agent-id") {
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

function printHelp() {
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
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

function parseDuration(value) {
  const match = /^(\d+)(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match)
    throw new Error(
      `Invalid --since value "${value}". Use values like 10m, 2h, or 45s.`,
    );
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

function hasAnyIdentifier(input) {
  return Boolean(
    input.agentId ||
    input.requestId ||
    input.messageId ||
    input.toolCallId ||
    input.runId,
  );
}

function identifierMap(input) {
  return compact({
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    runId: input.runId,
  });
}

function platformLogFiles(rootDir) {
  return [
    { layer: "api", path: join(rootDir, ".run-logs", "api.log") },
    { layer: "web", path: join(rootDir, ".run-logs", "web.log") },
  ];
}

function runtimeLogFiles(input) {
  const candidates = [
    ...input.runtimeLogPaths,
    join(input.rootDir, ".run-logs", "runtime.log"),
    resolve(
      input.rootDir,
      "..",
      "parallel-agent-runtime",
      ".run-logs",
      "runtime.log",
    ),
    resolve(
      input.rootDir,
      "..",
      "..",
      "parallel-agent-runtime",
      ".run-logs",
      "runtime.log",
    ),
  ];
  return [...new Set(candidates)].map((path) => ({ layer: "runtime", path }));
}

async function readLogFiles(files, sinceDate, identifiers) {
  const records = [];
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    const fileRecords = await readLogFile(file, sinceDate, identifiers);
    records.push(...fileRecords);
  }
  return records.sort(
    (left, right) =>
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
}

async function readLogFile(file, sinceDate, identifiers) {
  const records = [];
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    const record = parseLogLine({
      line,
      lineNumber,
      file,
      fallbackTimestamp: statSync(file.path).mtime.toISOString(),
    });
    if (new Date(record.timestamp).getTime() < sinceDate.getTime()) continue;
    if (!recordMatchesIdentifiers(record, identifiers)) continue;
    records.push(record);
  }

  return records;
}

function parseLogLine({ line, lineNumber, file, fallbackTimestamp }) {
  const parsed = parseJson(line);
  if (parsed) {
    return compact({
      layer:
        stringValue(parsed.layer) ?? stringValue(parsed.service) ?? file.layer,
      source: `${relative(ROOT_DIR, file.path)}:${lineNumber}`,
      timestamp: timestampFromRecord(parsed) ?? fallbackTimestamp,
      level: stringValue(parsed.level),
      event: stringValue(parsed.event),
      message:
        stringValue(parsed.message) ??
        stringValue(parsed.msg) ??
        line.slice(0, 300),
      method: stringValue(parsed.method),
      route:
        stringValue(parsed.route_pattern) ??
        stringValue(parsed.route) ??
        stringValue(parsed.path),
      statusCode: numberValue(parsed.status_code),
      requestId:
        stringValue(parsed.request_id) ?? stringValue(parsed.requestId),
      agentId: stringValue(parsed.agent_id) ?? stringValue(parsed.agentId),
      workspaceId:
        stringValue(parsed.workspace_id) ?? stringValue(parsed.workspaceId),
      messageId:
        stringValue(parsed.message_id) ?? stringValue(parsed.messageId),
      toolCallId:
        stringValue(parsed.tool_call_id) ?? stringValue(parsed.toolCallId),
      runId: stringValue(parsed.run_id) ?? stringValue(parsed.runId),
      text: line.slice(0, 500),
    });
  }

  return {
    ...parsePrettyLine(line),
    layer: file.layer,
    source: `${relative(ROOT_DIR, file.path)}:${lineNumber}`,
    timestamp: timestampFromText(line) ?? fallbackTimestamp,
    message: line.slice(0, 300),
    text: line.slice(0, 500),
  };
}

function parsePrettyLine(line) {
  const match = /^(\S+)\s+([A-Z]+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return {};
  const tokens = (match[4] ?? "").split(/\s+/).filter(Boolean);
  const method = HTTP_METHODS.has(tokens[0]) ? tokens.shift() : undefined;
  const route =
    tokens[0] && !tokens[0].includes("=") ? tokens.shift() : undefined;
  const fields = Object.fromEntries(
    tokens
      .map((token) => token.match(/^([^=\s]+)=(.*)$/))
      .filter(Boolean)
      .map((item) => [item[1], item[2]]),
  );
  return compact({
    level: match[2].toLowerCase(),
    event: match[3],
    method,
    route,
    statusCode: numberValue(fields.status),
    requestId: fields.request_id,
    agentId: fields.agent_id,
    workspaceId: fields.workspace_id,
    messageId: fields.message_id,
    toolCallId: fields.tool_call_id,
    runId: fields.run_id,
  });
}

function recordMatchesIdentifiers(record, identifiers) {
  const requested = Object.entries(identifiers).filter(
    ([key]) => key !== "workspaceId",
  );
  if (requested.length === 0) return false;
  if (
    identifiers.workspaceId &&
    record.workspaceId &&
    record.workspaceId !== identifiers.workspaceId
  )
    return false;

  return requested.some(
    ([key, value]) =>
      record[key] === value ||
      record.text?.includes(value) ||
      record.message?.includes(value),
  );
}

function summarizeLogLayer(name, records) {
  if (records.length === 0) {
    return check(name, "fail", "no matching log records found", {
      next: "rerun after the target action or widen --since",
    });
  }

  return check(
    name,
    "pass",
    `${records.length} matching log record${records.length === 1 ? "" : "s"}`,
    {
      evidence: records.slice(-MAX_EVIDENCE).map(summarizeRecord),
    },
  );
}

function summarizeRuntimeBoundary(records) {
  const matches = records.filter((record) =>
    /launcher|runtime|proxy|orchestrator|gateway|websocket|ws/i.test(
      `${record.event ?? ""} ${record.route ?? ""} ${record.message ?? ""}`,
    ),
  );
  if (matches.length === 0) {
    return check(
      "launcher/runtime proxy",
      "fail",
      "no matching platform runtime-boundary evidence",
      {
        next: "check .run-logs/api.log and rerun pnpm run logs:summary with the same identifiers",
      },
    );
  }
  return check(
    "launcher/runtime proxy",
    "pass",
    `${matches.length} matching boundary record${matches.length === 1 ? "" : "s"}`,
    {
      evidence: matches.slice(-MAX_EVIDENCE).map(summarizeRecord),
    },
  );
}

function summarizeRuntimeLogs(records, identifiers, runId) {
  if (!runId && records.length === 0) {
    return check(
      "runtime logs",
      "skip",
      "no --run-id or matching runtime log evidence supplied",
      {
        next: "pass --run-id and --runtime-log, or run runtime pnpm run logs:runtime -- --since 10m",
      },
    );
  }
  if (records.length === 0) {
    return check(
      "runtime logs",
      "fail",
      "no matching runtime log records found",
      {
        next: `run runtime pnpm run logs:runtime -- --since 10m${identifiers.runId ? ` --run-id ${identifiers.runId}` : ""}`,
      },
    );
  }
  return check(
    "runtime logs",
    "pass",
    `${records.length} matching runtime record${records.length === 1 ? "" : "s"}`,
    {
      evidence: records.slice(-MAX_EVIDENCE).map(summarizeRecord),
    },
  );
}

async function summarizeDiagnostic(input) {
  if (!input.agentId) {
    return check("agent diagnostic", "skip", "no --agent-id supplied");
  }

  const query = new URLSearchParams();
  if (input.workspaceId) query.set("workspaceId", input.workspaceId);
  const result = await probeHttpJson(
    `${input.apiBaseUrl}/api/diagnostic/agents/${encodeURIComponent(input.agentId)}${query.size ? `?${query}` : ""}`,
    {
      timeoutMs: 2000,
    },
  );

  if (!result.ok) {
    return check(
      "agent diagnostic",
      "fail",
      result.error ?? `request failed (${result.status ?? "no status"})`,
      {
        url: result.url,
        next: "start the platform with pnpm run dev and rerun this command",
      },
    );
  }

  const blockers = Array.isArray(result.json?.blockers)
    ? result.json.blockers
    : [];
  return check(
    "agent diagnostic",
    result.json?.canChat === false ? "fail" : "pass",
    result.json?.canChat === false
      ? `canChat=false (${blockers.length} blocker${blockers.length === 1 ? "" : "s"})`
      : "diagnostic reachable",
    {
      canChat: result.json?.canChat ?? null,
      blockers,
    },
  );
}

async function summarizeDashboard(input) {
  if (!input.agentId) {
    return check("dashboard rows", "skip", "no --agent-id supplied");
  }
  if (!input.token) {
    return check(
      "dashboard rows",
      "skip",
      "no --api-token or PLATFORM_API_TOKEN supplied",
    );
  }

  const headers = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  };
  const messageEvidence = input.messageId
    ? await fetchMessageEvidence(input, headers)
    : null;
  if (messageEvidence?.status === "fail") {
    return messageEvidence;
  }

  const latestRun = await probeHttpJson(
    `${input.apiBaseUrl}/api/agent-dashboard/${encodeURIComponent(input.agentId)}/latest-run`,
    {
      headers,
      timeoutMs: 3000,
    },
  );
  if (!latestRun.ok) {
    return check(
      "dashboard rows",
      "fail",
      latestRun.error ??
        `latest-run failed (${latestRun.status ?? "no status"})`,
      {
        next: "provide a valid Supabase access token with --api-token",
      },
    );
  }

  const run = latestRun.json?.run ?? null;
  const runMatches = !input.runId || run?.runId === input.runId;
  const details = {
    message: messageEvidence?.message ?? null,
    latestRun: run
      ? { runId: run.runId, status: run.status, updatedAt: run.updatedAt }
      : null,
  };
  if (messageEvidence && !input.runId && !input.toolCallId) {
    return check("dashboard rows", "pass", "message row found", details);
  }
  if (!run || !runMatches) {
    return check(
      "dashboard rows",
      "fail",
      input.runId
        ? `latest run did not match runId=${input.runId}`
        : "no latest run row found",
      details,
    );
  }

  if (!input.toolCallId) {
    return check("dashboard rows", "pass", "latest run row found", details);
  }

  const tasks = await probeHttpJson(
    `${input.apiBaseUrl}/api/agent-dashboard/${encodeURIComponent(input.agentId)}/tasks`,
    {
      method: "POST",
      headers,
      timeoutMs: 3000,
      body: JSON.stringify({ runIds: [run.runId] }),
    },
  );
  if (!tasks.ok) {
    return check(
      "dashboard rows",
      "fail",
      tasks.error ?? `task lookup failed (${tasks.status ?? "no status"})`,
      details,
    );
  }
  const toolEvents = Array.isArray(tasks.json?.tasks)
    ? tasks.json.tasks.flatMap((task) => task.toolEvents ?? [])
    : [];
  const matchingToolEvents = toolEvents.filter(
    (event) => event.toolCallId === input.toolCallId,
  );
  if (matchingToolEvents.length === 0) {
    return check(
      "dashboard rows",
      "fail",
      `no tool event row matched toolCallId=${input.toolCallId}`,
      details,
    );
  }
  return check(
    "dashboard rows",
    "pass",
    `${matchingToolEvents.length} matching tool event row${matchingToolEvents.length === 1 ? "" : "s"}`,
    {
      ...details,
      evidence: matchingToolEvents.slice(-MAX_EVIDENCE).map((event) => ({
        toolCallId: event.toolCallId,
        runId: event.runId,
        status: event.status,
        eventType: event.eventType,
        updatedAt: event.updatedAt,
      })),
    },
  );
}

async function fetchMessageEvidence(input, headers) {
  const messages = await probeHttpJson(
    `${input.apiBaseUrl}/api/agents/${encodeURIComponent(input.agentId)}/messages?limit=200`,
    {
      headers,
      timeoutMs: 3000,
    },
  );
  if (!messages.ok) {
    return check(
      "dashboard rows",
      "fail",
      messages.error ??
        `message lookup failed (${messages.status ?? "no status"})`,
      {
        next: "provide a valid Supabase access token with --api-token",
      },
    );
  }

  const matchingMessage = Array.isArray(messages.json?.messages)
    ? messages.json.messages.find((message) => message.id === input.messageId)
    : null;
  if (!matchingMessage) {
    return check(
      "dashboard rows",
      "fail",
      `no message row matched messageId=${input.messageId}`,
    );
  }

  return {
    status: "pass",
    message: {
      id: matchingMessage.id,
      role: matchingMessage.role ?? null,
      runId: matchingMessage.run_id ?? matchingMessage.runId ?? null,
      createdAt:
        matchingMessage.createdAt ?? matchingMessage.created_at ?? null,
    },
  };
}

async function summarizeBrowserArtifacts(input, identifiers) {
  if (!existsSync(input.artifactsDir)) {
    return check(
      "browser artifacts",
      "skip",
      `${relative(input.rootDir, input.artifactsDir)} does not exist`,
    );
  }

  const files = listFiles(input.artifactsDir).filter((file) => {
    try {
      return statSync(file).mtimeMs >= Date.now() - input.sinceMs;
    } catch {
      return false;
    }
  });
  const matches = [];
  const values = Object.values(identifiers);
  for (const file of files.slice(-200)) {
    const haystack = `${file}\n${await readArtifactSample(file)}`;
    if (values.some((value) => haystack.includes(value))) {
      matches.push(file);
    }
  }

  if (matches.length === 0) {
    return check(
      "browser artifacts",
      "skip",
      "no matching recent browser artifact found",
    );
  }
  return check(
    "browser artifacts",
    "pass",
    `${matches.length} matching artifact${matches.length === 1 ? "" : "s"}`,
    {
      evidence: matches
        .slice(-MAX_EVIDENCE)
        .map((file) => relative(input.rootDir, file)),
    },
  );
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    if (entry.isFile()) out.push(path);
  }
  return out;
}

async function readArtifactSample(file) {
  if (!/\.(json|txt|log|html|md)$/i.test(file)) return "";
  try {
    return (await readFile(file, "utf8")).slice(0, 20_000);
  } catch {
    return "";
  }
}

function summarizeRecord(record) {
  return compact({
    timestamp: record.timestamp,
    layer: record.layer,
    event: record.event,
    method: record.method,
    route: record.route,
    statusCode: record.statusCode,
    requestId: record.requestId,
    agentId: record.agentId,
    workspaceId: record.workspaceId,
    messageId: record.messageId,
    toolCallId: record.toolCallId,
    runId: record.runId,
    source: record.source,
    message: record.message,
  });
}

function printTrace(result) {
  console.log(`agent trace: ${result.status}`);
  console.log(`since: ${result.since}`);
  console.log(
    `identifiers: ${Object.entries(result.identifiers)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")}`,
  );
  console.log("");
  const nameWidth = Math.max(
    ...result.checks.map((item) => item.layer.length),
    5,
  );
  for (const item of result.checks) {
    console.log(
      `${item.status.padEnd(5)} ${item.layer.padEnd(nameWidth)} ${item.summary}`,
    );
    if (item.next)
      console.log(`${"".padEnd(6 + nameWidth)} next: ${item.next}`);
  }
}

function check(layer, status, summary, details = {}) {
  return compact({ layer, status, summary, ...details });
}

function parseJson(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function timestampFromRecord(record) {
  return (
    stringValue(record.timestamp) ??
    stringValue(record.time) ??
    stringValue(record.created_at) ??
    stringValue(record.createdAt)
  );
}

function timestampFromText(value) {
  const match = String(value).match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/,
  );
  return match ? new Date(match[0]).toISOString() : null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(number) ? number : null;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null && item !== "",
    ),
  );
}
