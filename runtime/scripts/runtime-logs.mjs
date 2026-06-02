#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEFAULT_LOG_DIR = path.join(ROOT_DIR, ".run-logs");
const DEFAULT_LAST = 200;
const SERVICES = {
  launcher: "launcher.log",
  orchestrator: "orchestrator.log",
};
const LEVELS = ["error", "warn", "info", "debug"];
const SECRET_PATTERNS = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/\b(apikey:\s*)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/\b(authorization:\s*)[^\s,}]+/gi, "$1[redacted]"],
  [/\b(SUPABASE_SERVICE_ROLE_KEY=)[^\s]+/gi, "$1[redacted]"],
  [/\b(SUPABASE_ANON_KEY=)[^\s]+/gi, "$1[redacted]"],
  [/\b(OPENAI_API_KEY=)[^\s]+/gi, "$1[redacted]"],
  [/\b(ANTHROPIC_API_KEY=)[^\s]+/gi, "$1[redacted]"],
  [/("arguments"\s*:\s*)\{[^{}]*\}/gi, "$1\"[redacted]\""],
];
const STRUCTURED_TEXT_FIELDS = ["prompt", "content"];

function parseArgs(argv) {
  const opts = {
    json: false,
    logDir: process.env.RUNTIME_LOG_DIR || DEFAULT_LOG_DIR,
    services: Object.keys(SERVICES),
    level: null,
    search: null,
    traceId: null,
    runId: null,
    sessionKey: null,
    since: null,
    last: DEFAULT_LAST,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--log-dir" && next) {
      opts.logDir = next;
      i += 1;
    } else if (arg === "--service" && next) {
      opts.services = parseServiceList(next);
      i += 1;
    } else if (arg === "--level" && next) {
      opts.level = parseLevel(next);
      i += 1;
    } else if ((arg === "--search" || arg === "--text") && next) {
      opts.search = next.toLowerCase();
      i += 1;
    } else if (arg === "--trace-id" && next) {
      opts.traceId = next;
      i += 1;
    } else if (arg === "--run-id" && next) {
      opts.runId = next;
      i += 1;
    } else if (arg === "--session-key" && next) {
      opts.sessionKey = next;
      i += 1;
    } else if (arg === "--since" && next) {
      opts.since = parseSince(next);
      i += 1;
    } else if ((arg === "--last" || arg === "-n") && next) {
      opts.last = parsePositiveInt(next, arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return opts;
}

function parseServiceList(value) {
  const services = value.split(",").map((service) => service.trim()).filter(Boolean);
  if (services.length === 0) {
    throw new Error("--service must include at least one service");
  }
  if (services.includes("all")) {
    if (services.length > 1) {
      throw new Error("--service all cannot be combined with other services");
    }
    return Object.keys(SERVICES);
  }

  for (const service of services) {
    if (!SERVICES[service]) {
      throw new Error(`--service must be one of: all, ${Object.keys(SERVICES).join(", ")}`);
    }
  }

  return services;
}

function parseLevel(value) {
  const normalized = value.toLowerCase();
  if (!LEVELS.includes(normalized)) {
    throw new Error(`--level must be one of: ${LEVELS.join(", ")}`);
  }
  return normalized;
}

function parseSince(value) {
  const match = value.match(/^(\d+)(ms|[smhd])$/i);
  if (!match) {
    throw new Error("--since must use a duration like 500ms, 30s, 10m, 2h, or 1d");
  }

  const amount = Number.parseInt(match[1], 10);
  const unitMs = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }[match[2].toLowerCase()];

  return {
    input: value,
    cutoffMs: Date.now() - amount * unitMs,
  };
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: pnpm run logs:runtime -- [options]

Options:
  --service <name>       Service to read: launcher, orchestrator, all, or comma-list. Default: all.
  --level <level>        Minimum classified level: error, warn, info, debug.
  --search <text>        Case-insensitive text filter. Alias: --text.
  --trace-id <id>        Match lines containing a trace id.
  --run-id <id>          Match lines containing a run id.
  --session-key <key>    Match lines containing a session key.
  --since <duration>     Include recent logs, e.g. 500ms, 30s, 10m, 2h, 1d.
  --last <n>, -n <n>     Return the last N matching lines. Default: ${DEFAULT_LAST}.
  --json                 Emit structured JSON.
  --log-dir <path>       Log directory. Default: ${DEFAULT_LOG_DIR}.

Examples:
  pnpm run logs:runtime
  pnpm run logs:runtime -- --since 10m --level error
  pnpm run logs:runtime -- --trace-id abc123
  pnpm run logs:runtime -- --service orchestrator --json`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const logDir = path.resolve(process.cwd(), opts.logDir);
  const files = opts.services.map((service) => ({
    service,
    path: path.join(logDir, SERVICES[service]),
  }));

  const { entries, missing } = await readLogEntries(files, opts);
  const filtered = filterEntries(entries, opts).slice(-opts.last);
  const summary = summarize(filtered, missing, opts, logDir);

  if (opts.json) {
    console.log(JSON.stringify({ ...summary, entries: filtered }, null, 2));
  } else {
    printHuman(summary, filtered);
  }
}

async function readLogEntries(files, opts) {
  const entries = [];
  const missing = [];

  for (const file of files) {
    if (!existsSync(file.path)) {
      missing.push({ service: file.service, path: file.path, reason: "missing" });
      continue;
    }

    const stat = statSync(file.path);
    if (opts.since && stat.mtimeMs < opts.since.cutoffMs) {
      continue;
    }

    const content = await readFile(file.path, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

    lines.forEach((line, index) => {
      entries.push(classifyLine(file, line, index + 1, stat));
    });
  }

  entries.sort((left, right) => {
    const leftTime = left.timestampMs ?? left.file_mtime_ms;
    const rightTime = right.timestampMs ?? right.file_mtime_ms;
    if (leftTime !== rightTime) return leftTime - rightTime;
    if (left.service !== right.service) return left.service.localeCompare(right.service);
    return left.line_number - right.line_number;
  });

  return { entries, missing };
}

function classifyLine(file, rawLine, lineNumber, stat) {
  const line = redact(rawLine);
  const timestamp = extractTimestamp(line, stat);

  return {
    service: file.service,
    level: classifyLevel(line),
    timestamp: timestamp?.iso ?? null,
    timestampMs: timestamp?.ms ?? null,
    file: file.path,
    file_mtime: stat.mtime.toISOString(),
    file_mtime_ms: stat.mtimeMs,
    line_number: lineNumber,
    message: line,
  };
}

function extractTimestamp(line, stat) {
  const candidates = [
    line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/),
    line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/),
    line.match(/^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]/),
  ];

  for (const match of candidates) {
    if (!match) continue;
    const parsed = Date.parse(match[1]);
    if (!Number.isNaN(parsed)) {
      return { iso: new Date(parsed).toISOString(), ms: parsed };
    }
  }

  const timeOnly = line.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s+\[/);
  if (timeOnly) {
    const parsed = timestampFromFileDate(timeOnly, stat.mtime);
    return { iso: parsed.toISOString(), ms: parsed.getTime() };
  }

  return null;
}

function timestampFromFileDate(match, fileMtime) {
  const parsed = new Date(fileMtime);
  const milliseconds = Number.parseInt((match[4] || "0").padEnd(3, "0").slice(0, 3), 10);

  parsed.setHours(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
    milliseconds,
  );

  if (parsed.getTime() > fileMtime.getTime() + 60_000) {
    parsed.setDate(parsed.getDate() - 1);
  }

  return parsed;
}

function classifyLevel(line) {
  const normalized = line.toLowerCase();

  if (/\b(error|failed|failure|exception|crash|panic)\b/.test(normalized)) {
    return "error";
  }
  if (/\b(warn|warning|timeout|timed out|retry|unhealthy)\b/.test(normalized)) {
    return "warn";
  }
  if (/\b(debug|trace)\b/.test(normalized)) {
    return "debug";
  }
  return "info";
}

function filterEntries(entries, opts) {
  return entries.filter((entry) => {
    if (opts.since) {
      const time = entry.timestampMs ?? entry.file_mtime_ms;
      if (time < opts.since.cutoffMs) return false;
    }

    if (opts.level && !levelMatches(entry.level, opts.level)) return false;
    if (opts.search && !entry.message.toLowerCase().includes(opts.search)) return false;
    if (opts.traceId && !entry.message.includes(opts.traceId)) return false;
    if (opts.runId && !entry.message.includes(opts.runId)) return false;
    if (opts.sessionKey && !entry.message.includes(opts.sessionKey)) return false;

    return true;
  });
}

function levelMatches(actual, minimum) {
  const order = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };
  return order[actual] <= order[minimum];
}

function summarize(entries, missing, opts, logDir) {
  const byService = {};
  const byLevel = {};

  for (const service of opts.services) {
    byService[service] = 0;
  }
  for (const level of LEVELS) {
    byLevel[level] = 0;
  }

  for (const entry of entries) {
    byService[entry.service] = (byService[entry.service] ?? 0) + 1;
    byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
  }

  return {
    ok: true,
    log_dir: logDir,
    filters: {
      services: opts.services,
      level: opts.level,
      search: opts.search,
      trace_id: opts.traceId,
      run_id: opts.runId,
      session_key: opts.sessionKey ? "[redacted]" : null,
      since: opts.since?.input ?? null,
      last: opts.last,
    },
    count: entries.length,
    by_service: byService,
    by_level: byLevel,
    missing,
  };
}

function printHuman(summary, entries) {
  const filterSummary = Object.entries(summary.filters)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`)
    .join(" ");

  console.log(`[runtime-logs] ${summary.count} matching line(s) from ${summary.log_dir}`);
  if (filterSummary) console.log(`[runtime-logs] filters: ${filterSummary}`);

  for (const missing of summary.missing) {
    console.log(`[runtime-logs] missing ${missing.service} log: ${missing.path}`);
  }

  if (entries.length === 0) {
    console.log("[runtime-logs] no matching log lines");
    return;
  }

  for (const entry of entries) {
    const timestamp = entry.timestamp ?? entry.file_mtime;
    console.log(`${timestamp} ${entry.service.padEnd(12)} ${entry.level.padEnd(5)} ${entry.message}`);
  }
}

function redact(value) {
  const redactedFields = STRUCTURED_TEXT_FIELDS.reduce(redactStructuredTextField, value);
  return SECRET_PATTERNS.reduce((line, [pattern, replacement]) => line.replace(pattern, replacement), redactedFields);
}

function redactStructuredTextField(line, field) {
  const pattern = new RegExp(`("${field}"\\s*:\\s*)"`, "gi");
  let redacted = "";
  let cursor = 0;
  let match;

  while ((match = pattern.exec(line)) !== null) {
    const valueStart = match.index + match[0].length;
    const valueEnd = findStructuredStringEnd(line, valueStart);

    redacted += line.slice(cursor, valueStart) + "[redacted]\"";
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }

  return redacted + line.slice(cursor);
}

function findStructuredStringEnd(line, valueStart) {
  for (let index = valueStart; index < line.length; index += 1) {
    if (line[index] !== "\"") continue;
    if (hasOddPrecedingBackslashes(line, index)) continue;
    if (!isLikelyJsonFieldBoundary(line.slice(index + 1))) continue;
    return index + 1;
  }

  return line.length;
}

function hasOddPrecedingBackslashes(line, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function isLikelyJsonFieldBoundary(rest) {
  const trimmed = rest.trimStart();
  return trimmed === "" || trimmed.startsWith("}") || /^,\s*"[\w-]+"\s*:/.test(trimmed);
}

main().catch((error) => {
  console.error(`[runtime-logs] failed: ${error.message}`);
  process.exit(1);
});
