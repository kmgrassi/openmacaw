import { createReadStream, existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { check } from "./format.mjs";

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

export function platformLogFiles(rootDir) {
  return [
    { layer: "api", path: join(rootDir, ".run-logs", "api.log") },
    { layer: "web", path: join(rootDir, ".run-logs", "web.log") },
  ];
}

export function runtimeLogFiles(input) {
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

export async function readLogFiles(files, sinceDate, identifiers, scriptRoot) {
  const records = [];
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    const fileRecords = await readLogFile(file, sinceDate, identifiers, scriptRoot);
    records.push(...fileRecords);
  }
  return records.sort(
    (left, right) =>
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
}

export function summarizeLogLayer(name, records) {
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

export function summarizeRuntimeBoundary(records) {
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

export function summarizeRuntimeLogs(records, identifiers, runId) {
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

async function readLogFile(file, sinceDate, identifiers, scriptRoot) {
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
      scriptRoot,
      fallbackTimestamp: statSync(file.path).mtime.toISOString(),
    });
    if (new Date(record.timestamp).getTime() < sinceDate.getTime()) continue;
    if (!recordMatchesIdentifiers(record, identifiers)) continue;
    records.push(record);
  }

  return records;
}

function parseLogLine({ line, lineNumber, file, scriptRoot, fallbackTimestamp }) {
  const parsed = parseJson(line);
  if (parsed) {
    return compact({
      layer:
        stringValue(parsed.layer) ?? stringValue(parsed.service) ?? file.layer,
      source: `${relative(scriptRoot, file.path)}:${lineNumber}`,
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
    source: `${relative(scriptRoot, file.path)}:${lineNumber}`,
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
  ) {
    return false;
  }

  return requested.some(
    ([key, value]) =>
      record[key] === value ||
      record.text?.includes(value) ||
      record.message?.includes(value),
  );
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
