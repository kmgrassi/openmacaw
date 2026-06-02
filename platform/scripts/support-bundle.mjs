#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = process.cwd();
const SUPPORT_ROOT = path.join(ROOT_DIR, ".run-artifacts", "support");
const LOG_DIR = path.join(ROOT_DIR, ".run-logs");
const DEFAULT_SINCE = "10m";
const DEFAULT_RAW_LOG_LINES = 200;
const SECRET_KEY_PATTERN =
  /(key|token|secret|password|credential|authorization|auth|private|cookie|session)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ASSIGNMENT_SECRET_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|credential|authorization|auth|private|cookie|session)[A-Za-z0-9_.-]*)\s*[:=]\s*(".*?"|'.*?'|[^\s,}]+)/gi;

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(
    `support bundle failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    console.log(usage());
    return;
  }

  const createdAt = new Date();
  const bundleDir = path.join(SUPPORT_ROOT, bundleTimestamp(createdAt));
  await mkdir(bundleDir, { recursive: true });

  const manifest = {
    status: "ok",
    createdAt: createdAt.toISOString(),
    bundleDir: relative(bundleDir),
    filters: compact({
      agentId: args.agentId,
      workspaceId: args.workspaceId,
      since: args.since,
      includeBrowser: args.includeBrowser,
    }),
    included: [],
    skipped: [],
  };

  await includeDoctor(bundleDir, manifest);
  await includeAgentDiagnostic(bundleDir, manifest);
  await includeLogs(bundleDir, manifest);
  await includeSchemaDiagnostics(bundleDir, manifest);
  await includeBrowserArtifacts(bundleDir, manifest);
  await includeGitInfo(bundleDir, manifest);

  if (manifest.skipped.length > 0) {
    manifest.status = "warn";
  }

  await writeJson(path.join(bundleDir, "manifest.json"), manifest);
  printManifest(manifest);
}

function parseArgs(rawArgs) {
  const parsed = {
    agentId: null,
    workspaceId: null,
    apiBaseUrl: process.env.PLATFORM_API_BASE_URL ?? "http://127.0.0.1:3100",
    apiToken:
      process.env.PLATFORM_API_TOKEN ?? process.env.API_AUTH_TOKEN ?? null,
    since: DEFAULT_SINCE,
    rawLogLines: DEFAULT_RAW_LOG_LINES,
    includeBrowser: false,
    help: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--agent-id") {
      parsed.agentId = requireValue(arg, rawArgs[index + 1]);
      index += 1;
    } else if (arg.startsWith("--agent-id=")) {
      parsed.agentId = arg.slice("--agent-id=".length);
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = requireValue(arg, rawArgs[index + 1]);
      index += 1;
    } else if (arg.startsWith("--workspace-id=")) {
      parsed.workspaceId = arg.slice("--workspace-id=".length);
    } else if (arg === "--api-base-url") {
      parsed.apiBaseUrl = requireValue(arg, rawArgs[index + 1]);
      index += 1;
    } else if (arg.startsWith("--api-base-url=")) {
      parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    } else if (arg === "--api-token") {
      parsed.apiToken = requireValue(arg, rawArgs[index + 1]);
      index += 1;
    } else if (arg.startsWith("--api-token=")) {
      parsed.apiToken = arg.slice("--api-token=".length);
    } else if (arg === "--since") {
      parsed.since = requireValue(arg, rawArgs[index + 1]);
      index += 1;
    } else if (arg.startsWith("--since=")) {
      parsed.since = arg.slice("--since=".length);
    } else if (arg === "--raw-log-lines") {
      parsed.rawLogLines = Number(requireValue(arg, rawArgs[index + 1]));
      index += 1;
    } else if (arg.startsWith("--raw-log-lines=")) {
      parsed.rawLogLines = Number(arg.slice("--raw-log-lines=".length));
    } else if (arg === "--include-browser") {
      parsed.includeBrowser = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.agentId = parsed.agentId?.trim() || null;
  parsed.workspaceId = parsed.workspaceId?.trim() || null;
  parsed.apiBaseUrl = parsed.apiBaseUrl.replace(/\/$/, "");

  if (!Number.isInteger(parsed.rawLogLines) || parsed.rawLogLines < 0) {
    throw new Error("--raw-log-lines must be a non-negative integer");
  }

  return parsed;
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage() {
  return `Usage: pnpm run support:bundle -- [options]

Options:
  --agent-id <id>          Include scoped agent diagnostics
  --workspace-id <id>      Workspace context for scoped diagnostics
  --api-base-url <url>     Platform API base URL (default: http://127.0.0.1:3100)
  --api-token <token>      Bearer token for authenticated API health endpoints
  --since <duration>       Recent log window for logs:summary (default: 10m)
  --raw-log-lines <count>  Redacted raw lines to include per log file (default: 200)
  --include-browser        Run smoke:web when available and include generated artifacts
`;
}

async function includeDoctor(bundleDir, manifest) {
  const doctorArgs = ["scripts/doctor.mjs", "--json", "--verbose"];
  if (args.agentId) doctorArgs.push("--agent-id", args.agentId);
  if (args.workspaceId) doctorArgs.push("--workspace-id", args.workspaceId);
  if (args.apiBaseUrl) doctorArgs.push("--api-base-url", args.apiBaseUrl);
  if (args.apiToken) doctorArgs.push("--api-token", args.apiToken);

  const result = await runCommand(process.execPath, doctorArgs);
  const artifact = await writeCommandResult(bundleDir, "doctor", result);
  include(manifest, "doctor", artifact, result);
}

async function includeAgentDiagnostic(bundleDir, manifest) {
  if (!args.agentId || !args.workspaceId) {
    skip(
      manifest,
      "agent diagnostic",
      "pass --agent-id and --workspace-id to collect scoped diagnostic JSON",
    );
    return;
  }

  const url = new URL(
    `/api/diagnostic/agents/${encodeURIComponent(args.agentId)}`,
    args.apiBaseUrl,
  );
  url.searchParams.set("workspaceId", args.workspaceId);

  const result = await fetchJson(url.href);
  const artifactPath = path.join(bundleDir, "agent-diagnostic.json");
  await writeJson(artifactPath, result);
  include(manifest, "agent diagnostic", relative(artifactPath), result);
}

async function includeLogs(bundleDir, manifest) {
  const summaryArgs = [
    "scripts/logs-summary.mjs",
    "--json",
    "--since",
    args.since,
  ];
  if (args.agentId) summaryArgs.push("--agent-id", args.agentId);
  if (args.workspaceId) summaryArgs.push("--workspace-id", args.workspaceId);

  const result = await runCommand(process.execPath, summaryArgs);
  const artifact = await writeCommandResult(bundleDir, "logs-summary", result);
  include(manifest, "logs summary", artifact, result);

  const rawLogDir = path.join(bundleDir, "raw-logs");
  await mkdir(rawLogDir, { recursive: true });

  for (const name of ["api.log", "web.log"]) {
    const logPath = path.join(LOG_DIR, name);
    if (!existsSync(logPath)) {
      skip(manifest, `raw ${name}`, `${relative(logPath)} does not exist`);
      continue;
    }

    const excerpt = await tailLines(logPath, args.rawLogLines);
    const artifactPath = path.join(rawLogDir, name);
    await writeText(artifactPath, excerpt);
    include(manifest, `raw ${name}`, relative(artifactPath), {
      lineCount: excerpt ? excerpt.split(/\r?\n/).length : 0,
    });
  }
}

async function includeSchemaDiagnostics(bundleDir, manifest) {
  const result = await runCommand(process.execPath, [
    "scripts/check-supabase-schema.mjs",
  ]);
  const artifact = await writeCommandResult(
    bundleDir,
    "schema-diagnostics",
    result,
  );
  include(manifest, "schema diagnostics", artifact, result);
}

async function includeBrowserArtifacts(bundleDir, manifest) {
  if (!args.includeBrowser) {
    skip(manifest, "browser smoke", "not requested; pass --include-browser");
    return;
  }

  if (!(await packageScriptExists("smoke:web"))) {
    skip(manifest, "browser smoke", "package.json has no smoke:web script");
    return;
  }

  const before = await listArtifactEntries();
  const result = await runCommand("pnpm", ["run", "smoke:web"], {
    timeoutMs: 120_000,
  });
  const artifact = await writeCommandResult(bundleDir, "browser-smoke", result);
  include(manifest, "browser smoke output", artifact, result);

  const after = await listArtifactEntries();
  const newEntries = after.filter((entry) => !before.has(entry));
  if (newEntries.length === 0) {
    skip(
      manifest,
      "browser smoke artifacts",
      "smoke:web did not create new .run-artifacts entries",
    );
    return;
  }

  const artifactPath = path.join(bundleDir, "browser-artifacts.json");
  await writeJson(artifactPath, {
    entries: newEntries,
  });
  include(manifest, "browser smoke artifacts", relative(artifactPath), {
    entryCount: newEntries.length,
  });
}

async function includeGitInfo(bundleDir, manifest) {
  const commands = [
    {
      name: "branch",
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
    },
    {
      name: "commit",
      args: ["rev-parse", "HEAD"],
    },
    {
      name: "status",
      args: ["status", "--short", "--branch"],
    },
    {
      name: "changed-files",
      args: ["diff", "--name-only", "HEAD"],
    },
  ];
  const git = {};

  for (const command of commands) {
    const result = await runCommand("git", command.args);
    git[command.name] = commandResultSummary(result);
  }

  const packageManager = await runCommand("pnpm", ["--version"]);
  git.packageManager = {
    name: "pnpm",
    version: packageManager.stdout.trim() || null,
    exitCode: packageManager.exitCode,
  };

  const artifactPath = path.join(bundleDir, "git-info.json");
  await writeJson(artifactPath, git);
  include(manifest, "git info", relative(artifactPath), git);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(args.apiToken ? { authorization: `Bearer ${args.apiToken}` } : {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      url,
      status: response.status,
      statusText: response.statusText,
      body: parseJson(text) ?? text,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      error:
        error instanceof Error && error.name === "AbortError"
          ? "timeout"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function runCommand(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;

  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...commandArgs],
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        error: error.message,
        stdout,
        stderr,
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...commandArgs],
        ok: exitCode === 0,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

async function writeCommandResult(bundleDir, basename, result) {
  const stdoutPath = path.join(
    bundleDir,
    `${basename}.${looksJson(result.stdout) ? "json" : "txt"}`,
  );
  await writeText(stdoutPath, result.stdout || "");

  if (result.stderr) {
    await writeText(
      path.join(bundleDir, `${basename}.stderr.txt`),
      result.stderr,
    );
  }

  await writeJson(path.join(bundleDir, `${basename}.meta.json`), {
    command: redactValue(result.command),
    ok: result.ok,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    error: result.error,
  });

  return relative(stdoutPath);
}

async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(redactValue(value), null, 2)}\n`);
}

async function writeText(filePath, value) {
  await writeFile(filePath, redactText(String(value)), "utf8");
}

async function tailLines(filePath, lineCount) {
  if (lineCount === 0) return "";
  const source = await readFile(filePath, "utf8");
  return source.split(/\r?\n/).slice(-lineCount).join("\n");
}

async function packageScriptExists(scriptName) {
  const packageJson = parseJson(
    await readFile(path.join(ROOT_DIR, "package.json"), "utf8"),
  );
  return Boolean(packageJson?.scripts?.[scriptName]);
}

async function listArtifactEntries() {
  const artifactDir = path.join(ROOT_DIR, ".run-artifacts");
  const entries = new Set();
  if (!existsSync(artifactDir)) return entries;

  for (const entry of await walk(artifactDir)) {
    entries.add(relative(entry));
  }
  return entries;
}

async function walk(directory) {
  const entries = [];
  for (const dirent of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, dirent.name);
    if (dirent.isDirectory()) {
      entries.push(...(await walk(fullPath)));
    } else {
      entries.push(fullPath);
    }
  }
  return entries;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function redactValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(child),
      ]),
    );
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  return value;
}

function redactText(value) {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1=[redacted]");
}

function commandResultSummary(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error,
  };
}

function include(manifest, name, artifact, result) {
  manifest.included.push(
    compact({
      name,
      artifact,
      ok: typeof result?.ok === "boolean" ? result.ok : undefined,
      exitCode:
        typeof result?.exitCode === "number" || result?.exitCode === null
          ? result.exitCode
          : undefined,
    }),
  );
}

function skip(manifest, name, reason) {
  manifest.skipped.push({ name, reason });
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null,
    ),
  );
}

function bundleTimestamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function relative(filePath) {
  return path.relative(ROOT_DIR, filePath) || ".";
}

function printManifest(manifest) {
  console.log(`support bundle: ${manifest.status}`);
  console.log(`path: ${manifest.bundleDir}`);
  console.log("");
  console.log("included:");
  for (const item of manifest.included) {
    const status = item.ok === false ? "warn" : "ok";
    console.log(`  ${status} ${item.name} -> ${item.artifact}`);
  }
  if (manifest.skipped.length > 0) {
    console.log("");
    console.log("skipped:");
    for (const item of manifest.skipped) {
      console.log(`  skip ${item.name}: ${item.reason}`);
    }
  }
}
