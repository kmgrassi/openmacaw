#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";

const ROOT_DIR = process.cwd();
const LOG_DIR = join(ROOT_DIR, ".run-logs");
const DEFAULT_SINCE_MS = 10 * 60 * 1000;
const MAX_TEXT_RECORDS = 25;
const LOG_FILES = [
  { layer: "api", path: join(LOG_DIR, "api.log") },
  { layer: "web", path: join(LOG_DIR, "web.log") },
];
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
const sinceMs = args.since ? parseDuration(args.since) : DEFAULT_SINCE_MS;
const sinceDate = new Date(Date.now() - sinceMs);

main().catch((error) => {
  console.error(
    `logs summary failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

async function main() {
  const snapshot = await readSnapshot({
    sinceDate,
    agentId: args.agentId,
    workspaceId: args.workspaceId,
  });

  if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    printSummary(snapshot);
  }

  if (args.follow) {
    if (args.json) {
      console.error(
        "logs:summary --follow streams newline-delimited JSON records after the initial snapshot",
      );
    } else {
      console.log("");
      console.log("following new warning/error records; press Ctrl+C to stop");
    }
    await followLogs(snapshot.files);
  }
}

function parseArgs(rawArgs) {
  const parsed = {
    since: undefined,
    agentId: undefined,
    workspaceId: undefined,
    follow: false,
    json: false,
    verbose: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const value = rawArgs[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--since") {
      parsed.since = requireValue(arg, value);
      index += 1;
    } else if (arg?.startsWith("--since=")) {
      parsed.since = arg.slice("--since=".length);
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
    } else if (arg === "--follow") {
      parsed.follow = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: pnpm run logs:summary -- [options]

Options:
  --since <duration>       Time window to read, for example 10m, 2h, 45s. Default: 10m
  --agent-id <id>          Include API log records for this agent_id
  --workspace-id <id>      Include API log records for this workspace_id
  --json                   Print grouped records as JSON
  --follow                 Continue streaming new warning/error records
  --verbose                Include extra recent warning/error records in text output
`);
}

function parseDuration(value) {
  const match = /^(\d+)(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid --since value "${value}". Use values like 10m, 2h, or 45s.`,
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
}

async function readSnapshot(filters) {
  const warnings = [];
  const records = [];
  const files = [];

  for (const file of LOG_FILES) {
    if (!existsSync(file.path)) {
      warnings.push(`${file.layer} log missing: ${relative(file.path)}`);
      files.push({ ...file, exists: false, size: 0 });
      continue;
    }

    const stats = statSync(file.path);
    files.push({
      ...file,
      exists: true,
      size: stats.size,
      mtime: stats.mtime.toISOString(),
    });

    const fileRecords = await readLogFile(file, filters, warnings);
    records.push(...fileRecords);
  }

  records.sort(
    (left, right) =>
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );

  const highlighted = highlightRecords(records);
  const groupedRecords = groupRecords(records);

  return {
    status: warnings.length > 0 ? "warn" : "ok",
    since: filters.sinceDate.toISOString(),
    filters: compact({
      agentId: filters.agentId,
      workspaceId: filters.workspaceId,
    }),
    files: files.map((file) =>
      compact({
        layer: file.layer,
        path: relative(file.path),
        exists: file.exists,
        size: file.size,
        mtime: file.mtime,
      }),
    ),
    warnings,
    summary: {
      totalRecords: records.length,
      warningOrErrorRecords: records.filter((record) => record.isFailure)
        .length,
      groups: groupedRecords.length,
    },
    highlights: highlighted,
    groups: groupedRecords,
    recentRecords: records.slice(-MAX_TEXT_RECORDS).map(summarizeRecord),
  };
}

async function readLogFile(file, filters, warnings) {
  const records = [];
  const stream = createReadStream(file.path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;

    const record = parseLogLine({
      line,
      lineNumber,
      layer: file.layer,
      filePath: file.path,
      warnings,
    });
    if (!record) continue;
    if (!recordMatchesFilters(record, filters)) continue;

    records.push(record);
  }

  return records;
}

function parseLogLine({ line, lineNumber, layer, filePath, warnings }) {
  const parsed = parseJson(line);
  const now = new Date().toISOString();

  if (parsed) {
    const timestamp = timestampFromRecord(parsed) ?? now;
    return enrichRecord({
      layer: layerFromRecord(parsed, layer),
      source: relative(filePath),
      lineNumber,
      timestamp,
      message:
        stringValue(parsed.message) ??
        stringValue(parsed.msg) ??
        line.slice(0, 240),
      event: stringValue(parsed.event),
      level: stringValue(parsed.level),
      traceId: stringValue(parsed.trace_id),
      requestId: stringValue(parsed.request_id),
      agentId: stringValue(parsed.agent_id),
      workspaceId: stringValue(parsed.workspace_id),
      runId: stringValue(parsed.run_id),
      toolCallId: stringValue(parsed.tool_call_id),
      route:
        stringValue(parsed.route_pattern) ??
        stringValue(parsed.route) ??
        stringValue(parsed.path),
      method: stringValue(parsed.method),
      statusCode: numberValue(parsed.status_code),
      errorCode: stringValue(parsed.error_code) ?? stringValue(parsed.code),
    });
  }

  if (layer === "api" && line.trim().startsWith("{")) {
    warnings.push(`Malformed JSON in ${relative(filePath)}:${lineNumber}`);
  }

  const prettyApiRecord =
    layer === "api"
      ? parsePrettyApiLine({ line, lineNumber, filePath })
      : undefined;
  if (prettyApiRecord) {
    return enrichRecord(prettyApiRecord);
  }

  return enrichRecord({
    layer,
    source: relative(filePath),
    lineNumber,
    timestamp: timestampFromText(line) ?? now,
    message: line.slice(0, 300),
    event: eventFromText(line),
    level: levelFromText(line),
  });
}

function parsePrettyApiLine({ line, lineNumber, filePath }) {
  const match = /^(\S+)\s+([A-Z]+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return undefined;

  const timestamp = parseTimestamp(match[1]);
  if (!timestamp) return undefined;

  const level = match[2].toLowerCase();
  const event = match[3];
  const tokens = (match[4] ?? "").split(/\s+/).filter(Boolean);
  const method = HTTP_METHODS.has(tokens[0]) ? tokens.shift() : undefined;
  const route =
    tokens[0] && !tokens[0].includes("=") ? tokens.shift() : undefined;
  const fields = parseKeyValueTokens(tokens);

  return {
    layer: "api",
    source: relative(filePath),
    lineNumber,
    timestamp,
    message: line.slice(0, 300),
    event,
    level,
    method,
    route,
    statusCode: numberValueFromString(fields.status),
    errorCode: fields.error_code,
    requestId: fields.request_id,
    agentId: fields.agent_id,
    workspaceId: fields.workspace_id,
    runId: fields.run_id,
    toolCallId: fields.tool_call_id,
  };
}

function parseKeyValueTokens(tokens) {
  return Object.fromEntries(
    tokens
      .map((token) => token.match(/^([^=\s]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

function parseJson(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function enrichRecord(record) {
  const classification = classifyRecord(record);
  return {
    ...compact(record),
    category: classification.category,
    isFailure: classification.isFailure,
    label: classification.label,
  };
}

function classifyRecord(record) {
  const text =
    `${record.event ?? ""} ${record.message ?? ""} ${record.errorCode ?? ""}`.toLowerCase();
  const level = String(record.level ?? "").toLowerCase();
  const statusCode = Number(record.statusCode);

  if (text.includes("supabase"))
    return { category: "supabase", isFailure: true, label: "Supabase failure" };
  if (text.includes("launcher"))
    return { category: "launcher", isFailure: true, label: "Launcher failure" };
  if (
    text.includes("websocket") ||
    text.includes("gateway_ws") ||
    text.includes(" close")
  ) {
    return {
      category: "websocket",
      isFailure: true,
      label: "Websocket close/failure",
    };
  }
  if (
    record.layer === "web" &&
    /error|failed|exception|vite|hmr|runtime/i.test(text)
  ) {
    return {
      category: "browser",
      isFailure: true,
      label: "Browser build/runtime error",
    };
  }
  if (record.event === "request_failed" || statusCode >= 400) {
    return { category: "request", isFailure: true, label: "Request failure" };
  }
  if (
    level === "error" ||
    level === "warn" ||
    /error|failed|exception|timeout|refused/i.test(text)
  ) {
    return { category: "error", isFailure: true, label: "Warning/error" };
  }

  return { category: "record", isFailure: false, label: "Log record" };
}

function recordMatchesFilters(record, filters) {
  if (new Date(record.timestamp).getTime() < filters.sinceDate.getTime())
    return false;
  if (filters.agentId && record.agentId && record.agentId !== filters.agentId)
    return false;
  if (
    filters.workspaceId &&
    record.workspaceId &&
    record.workspaceId !== filters.workspaceId
  )
    return false;
  return true;
}

function highlightRecords(records) {
  const failures = records.filter((record) => record.isFailure);
  const highlights = {
    lastRequestFailure: lastMatching(
      failures,
      (record) =>
        record.event === "request_failed" || Number(record.statusCode) >= 400,
    ),
    lastSupabaseFailure: lastMatching(
      failures,
      (record) => record.category === "supabase",
    ),
    lastLauncherFailure: lastMatching(
      failures,
      (record) => record.category === "launcher",
    ),
    lastWebsocketClose: lastMatching(
      failures,
      (record) => record.category === "websocket",
    ),
    lastBrowserError: lastMatching(
      failures,
      (record) => record.category === "browser",
    ),
  };

  return Object.fromEntries(
    Object.entries(highlights)
      .filter(([, record]) => record)
      .map(([key, record]) => [key, summarizeRecord(record)]),
  );
}

function lastMatching(records, predicate) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (predicate(record)) return record;
  }
  return undefined;
}

function groupRecords(records) {
  const grouped = new Map();

  for (const record of records.filter((item) => item.isFailure)) {
    const keyParts = [
      record.traceId,
      record.requestId,
      record.agentId,
      record.workspaceId,
      record.runId,
      record.toolCallId,
      record.route,
      record.event,
      record.errorCode,
      record.layer,
      record.category,
    ];
    const key = keyParts.map((part) => part ?? "-").join("|");
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = record.timestamp;
      existing.records.push(summarizeRecord(record));
    } else {
      grouped.set(key, {
        key,
        count: 1,
        firstSeen: record.timestamp,
        lastSeen: record.timestamp,
        group: compact({
          traceId: record.traceId,
          requestId: record.requestId,
          agentId: record.agentId,
          workspaceId: record.workspaceId,
          runId: record.runId,
          toolCallId: record.toolCallId,
          route: record.route,
          event: record.event,
          errorCode: record.errorCode,
          layer: record.layer,
          category: record.category,
        }),
        records: [summarizeRecord(record)],
      });
    }
  }

  return [...grouped.values()]
    .sort(
      (left, right) =>
        new Date(right.lastSeen).getTime() - new Date(left.lastSeen).getTime(),
    )
    .slice(0, args.verbose ? 25 : 12);
}

function summarizeRecord(record) {
  return compact({
    timestamp: record.timestamp,
    layer: record.layer,
    category: record.category,
    label: record.label,
    level: record.level,
    event: record.event,
    method: record.method,
    route: record.route,
    statusCode: record.statusCode,
    errorCode: record.errorCode,
    traceId: record.traceId,
    requestId: record.requestId,
    agentId: record.agentId,
    workspaceId: record.workspaceId,
    runId: record.runId,
    toolCallId: record.toolCallId,
    source: `${record.source}:${record.lineNumber}`,
    message: record.message,
  });
}

function printSummary(snapshot) {
  console.log(`platform logs summary: ${snapshot.status}`);
  console.log(`since: ${snapshot.since}`);
  console.log(
    `records: ${snapshot.summary.totalRecords} recent, ${snapshot.summary.warningOrErrorRecords} warning/error, ${snapshot.summary.groups} groups`,
  );

  if (Object.keys(snapshot.filters).length > 0) {
    console.log(
      `filters: ${Object.entries(snapshot.filters)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")}`,
    );
  }

  for (const warning of snapshot.warnings) {
    console.log(`warn  ${warning}`);
  }

  console.log("");
  console.log("highlights:");
  const highlights = Object.entries(snapshot.highlights);
  if (highlights.length === 0) {
    console.log("  none");
  } else {
    for (const [name, record] of highlights) {
      console.log(`  ${name}: ${formatRecord(record)}`);
    }
  }

  console.log("");
  console.log("failure groups:");
  if (snapshot.groups.length === 0) {
    console.log("  none");
  } else {
    for (const group of snapshot.groups) {
      const groupLabel = Object.entries(group.group)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      console.log(`  ${group.count}x ${groupLabel}`);
      console.log(
        `     last: ${formatRecord(group.records[group.records.length - 1])}`,
      );
    }
  }

  const recentFailures = snapshot.recentRecords
    .filter((record) => record.isFailure)
    .slice(args.verbose ? -12 : -6);
  if (recentFailures.length > 0) {
    console.log("");
    console.log("recent warning/error records:");
    for (const record of recentFailures) {
      console.log(`  ${formatRecord(record)}`);
    }
  }
}

function formatRecord(record) {
  const status = record.statusCode ? ` status=${record.statusCode}` : "";
  const route = record.route
    ? ` ${record.method ? `${record.method} ` : ""}${record.route}`
    : "";
  const event = record.event ? ` ${record.event}` : "";
  const code = record.errorCode ? ` code=${record.errorCode}` : "";
  const source = record.source ? ` (${record.source})` : "";
  const message = record.message ? ` ${record.message}` : "";
  return `${record.timestamp} [${record.layer}/${record.category}]${event}${route}${status}${code}${source}${message}`.slice(
    0,
    500,
  );
}

async function followLogs(files) {
  const offsets = new Map();
  for (const file of LOG_FILES.filter((item) => existsSync(item.path))) {
    offsets.set(file.path, statSync(file.path).size);
  }

  while (true) {
    for (const file of LOG_FILES) {
      if (!existsSync(file.path)) continue;
      const start = offsets.get(file.path) ?? 0;
      const size = statSync(file.path).size;
      if (size <= start) continue;

      const handle = await open(file.path, "r");
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      await handle.close();
      offsets.set(file.path, size);

      const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const [index, line] of lines.entries()) {
        const record = parseLogLine({
          line,
          lineNumber: undefined,
          layer: file.layer,
          filePath: file.path,
          warnings: [],
        });
        if (!record?.isFailure) continue;
        if (
          !recordMatchesFilters(record, {
            sinceDate: new Date(0),
            agentId: args.agentId,
            workspaceId: args.workspaceId,
          })
        )
          continue;

        const summarized = summarizeRecord({
          ...record,
          lineNumber: record.lineNumber ?? `+${index + 1}`,
        });
        if (args.json) {
          console.log(JSON.stringify(summarized));
        } else {
          console.log(`  ${formatRecord(summarized)}`);
        }
      }
    }

    await delay(1000);
  }
}

function timestampFromRecord(record) {
  for (const key of ["timestamp", "time", "ts"]) {
    const value = record[key];
    if (typeof value === "string") {
      const timestamp = parseTimestamp(value);
      if (timestamp) return timestamp;
    }
  }
  return undefined;
}

function timestampFromText(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T[^\s]+)/.exec(line);
  if (!match) return undefined;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function eventFromText(line) {
  if (/websocket|gateway_ws/i.test(line)) return "websocket_log";
  if (/vite/i.test(line)) return "vite_log";
  if (/error|failed|exception/i.test(line)) return "error_log";
  return undefined;
}

function levelFromText(line) {
  if (/\b(error|err)\b/i.test(line)) return "error";
  if (/\b(warn|warning)\b/i.test(line)) return "warn";
  return "info";
}

function layerFromRecord(record, fallback) {
  const service = stringValue(record.service)?.toLowerCase();
  if (service?.includes("web")) return "web";
  if (
    service?.includes("api") ||
    service?.includes("express") ||
    service?.includes("server")
  )
    return "api";
  return stringValue(record.layer) ?? fallback;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function numberValueFromString(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function compact(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function relative(path) {
  return path.startsWith(`${ROOT_DIR}/`)
    ? path.slice(ROOT_DIR.length + 1)
    : basename(path);
}
