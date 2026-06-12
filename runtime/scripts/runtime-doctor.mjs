#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");
const DEFAULT_LAUNCHER_URL = "http://127.0.0.1:4100";
const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:4000";
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_LOG_STALE_MS = 10 * 60_000;
const REQUIRED_CLIS = ["mise", "pnpm", "node", "mix", "curl", "lsof"];
const PORTS = [
  { port: 4000, service: "orchestrator", required: true, expected: ["beam.smp", "symphony"] },
  { port: 4100, service: "launcher", required: true, expected: ["beam.smp", "mix"] },
  { port: 3100, service: "platform_api", required: false, expected: [] },
  { port: 5173, service: "platform_web", required: false, expected: [] },
  { port: 11434, service: "ollama", required: false, expected: ["ollama"] },
];
const LOGS = [
  { service: "launcher", path: ".run-logs/launcher.log" },
  { service: "orchestrator", path: ".run-logs/orchestrator.log" },
];
const ENV_CANDIDATES = [
  "apps/orchestrator/.env",
  ".env",
  path.join(os.homedir(), ".symphony/runtime.env"),
  path.join(os.homedir(), ".symphony/orchestrator.env"),
];

function parseArgs(argv) {
  const opts = {
    json: false,
    launcherUrl: process.env.LAUNCHER_URL || DEFAULT_LAUNCHER_URL,
    orchestratorUrl: process.env.ORCHESTRATOR_URL || DEFAULT_ORCHESTRATOR_URL,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || process.env.MANAGER_WORKSPACE_ID || "",
    targetRunnerKind: process.env.RUNTIME_TARGET_RUNNER_KIND || "openai_compatible",
    model: process.env.RUNTIME_MODEL || "",
    timeoutMs: numberFromEnv("RUNTIME_DOCTOR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    logStaleMs: numberFromEnv("RUNTIME_DOCTOR_LOG_STALE_MS", DEFAULT_LOG_STALE_MS),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--launcher-url" && next) {
      opts.launcherUrl = next;
      i += 1;
    } else if (arg === "--orchestrator-url" && next) {
      opts.orchestratorUrl = next;
      i += 1;
    } else if (arg === "--workspace-id" && next) {
      opts.workspaceId = next;
      i += 1;
    } else if (arg === "--target-runner-kind" && next) {
      opts.targetRunnerKind = next;
      i += 1;
    } else if (arg === "--model" && next) {
      opts.model = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = parsePositiveInt(next, "--timeout-ms");
      i += 1;
    } else if (arg === "--log-stale-ms" && next) {
      opts.logStaleMs = parsePositiveInt(next, "--log-stale-ms");
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  opts.launcherUrl = trimTrailingSlash(opts.launcherUrl);
  opts.orchestratorUrl = trimTrailingSlash(opts.orchestratorUrl);
  opts.workspaceId = opts.workspaceId.trim();
  opts.targetRunnerKind = opts.targetRunnerKind.trim();
  opts.model = opts.model.trim();
  return opts;
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return parsePositiveInt(value, name);
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: pnpm run doctor:runtime [-- --json]

Options:
  --json                     Print machine-readable JSON only.
  --launcher-url <url>       Launcher base URL. Default: ${DEFAULT_LAUNCHER_URL}
  --orchestrator-url <url>   Orchestrator base URL. Default: ${DEFAULT_ORCHESTRATOR_URL}
  --workspace-id <id>        Check local helper readiness for this workspace.
  --target-runner-kind <kind>
                             Helper runner kind. Default: openai_compatible
  --model <name>             Require this local model in helper diagnostics.
  --timeout-ms <ms>          HTTP and command timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --log-stale-ms <ms>        Log freshness threshold. Default: ${DEFAULT_LOG_STALE_MS}

Environment:
  LAUNCHER_URL, ORCHESTRATOR_URL, RUNTIME_WORKSPACE_ID, MANAGER_WORKSPACE_ID,
  RUNTIME_TARGET_RUNNER_KIND, RUNTIME_MODEL, RUNTIME_DOCTOR_TIMEOUT_MS,
  RUNTIME_DOCTOR_LOG_STALE_MS`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const catalog = await loadFailureCatalog();
  const [cli, services, localRuntime, ports, logs, env] = await Promise.all([
    checkRequiredClis(),
    checkServices(opts),
    checkLocalRuntime(opts),
    checkPorts(opts),
    checkLogs(opts),
    checkEnvFiles(),
  ]);

  const failures = collectFailures({ cli, services, localRuntime, ports, opts });
  const warnings = collectWarnings({ logs, env });
  const nextSteps = nextStepsFor([...failures, ...warnings], catalog);
  const ok = failures.length === 0;

  const result = {
    ok,
    checked_at: new Date().toISOString(),
    root_dir: ROOT_DIR,
    cli,
    services,
    local_runtime: localRuntime,
    ports,
    logs,
    env,
    failures: failures.map((failure) => explainFailure(failure, catalog)),
    warnings: warnings.map((warning) => explainFailure(warning, catalog)),
    next_steps: nextSteps,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  process.exit(ok ? 0 : 1);
}

async function checkLocalRuntime(opts) {
  const url = localRuntimeHealthUrl(opts);
  const response = await fetchJson(url, opts.timeoutMs, serviceRoleHeaders());

  if (response.status !== "reachable") {
    return {
      status: "unavailable",
      url,
      reason: response.error,
      helpers: [],
      filters: localRuntimeFilters(opts),
    };
  }

  const payload = response.payload ?? {};

  return {
    status: payload.ok === true ? "healthy" : "degraded",
    url,
    reason: payload.reason ?? null,
    missing_capabilities: Array.isArray(payload.missing_capabilities) ? payload.missing_capabilities : [],
    helpers: Array.isArray(payload.helpers) ? payload.helpers : [],
    filters: payload.filters ?? localRuntimeFilters(opts),
  };
}

function localRuntimeHealthUrl(opts) {
  const url = new URL("/api/v1/local-runtime/health", opts.orchestratorUrl);
  if (opts.workspaceId) url.searchParams.set("workspace_id", opts.workspaceId);
  if (opts.targetRunnerKind) url.searchParams.set("target_runner_kind", opts.targetRunnerKind);
  if (opts.model) url.searchParams.set("model", opts.model);
  return url.href;
}

function localRuntimeFilters(opts) {
  return {
    workspace_id: opts.workspaceId || null,
    target_runner_kind: opts.targetRunnerKind || null,
    model: opts.model || null,
  };
}

async function loadFailureCatalog() {
  const catalogPath = path.join(ROOT_DIR, "scripts/diagnostics/failure-catalog.json");
  const text = await readFile(catalogPath, "utf8");
  return JSON.parse(text);
}

async function checkRequiredClis() {
  const entries = await Promise.all(
    REQUIRED_CLIS.map(async (name) => {
      const executablePath = await findExecutable(name);
      if (!executablePath) {
        return { name, status: "missing", error: "not found" };
      }

      return { name, status: "present", path: executablePath };
    }),
  );

  return {
    ok: entries.every((entry) => entry.status === "present"),
    entries,
  };
}

async function findExecutable(name) {
  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const pathEntry of pathEntries) {
    const candidate = path.join(pathEntry, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH entries.
    }
  }

  return null;
}

async function checkServices(opts) {
  const launcherUrl = `${opts.launcherUrl}/health`;
  const orchestratorUrl = `${opts.orchestratorUrl}/api/v1/health`;
  const [launcher, orchestrator] = await Promise.all([
    checkLauncher(launcherUrl, opts),
    checkOrchestrator(orchestratorUrl, opts),
  ]);

  return { launcher, orchestrator };
}

async function checkLauncher(url, opts) {
  const response = await fetchJson(url, opts.timeoutMs);
  if (response.status !== "reachable") return { ...response, service: "launcher" };

  const payload = response.payload;
  let status = payload?.ok === true ? "healthy" : "unhealthy";
  let database = null;

  if (payload?.database) {
    database = {
      status: payload.database.status ?? "unknown",
      connected: payload.database.connected === true,
      last_error: payload.database.last_error ?? null,
    };
    if (!database.connected) status = "unhealthy";
  }

  return {
    service: "launcher",
    status,
    url,
    http_status: response.http_status,
    database,
  };
}

async function checkOrchestrator(url, opts) {
  const response = await fetchJson(url, opts.timeoutMs);
  if (response.status !== "reachable") return { ...response, service: "orchestrator" };

  const payload = response.payload;
  const healthy = payload?.ok === true || payload?.status === "ok" || payload?.status === "healthy";

  return {
    service: "orchestrator",
    status: healthy ? "healthy" : "unhealthy",
    url,
    http_status: response.http_status,
  };
}

// /api/v1/local-runtime/* sits behind RequireServiceRoleBearer.
function serviceRoleHeaders() {
  const key = (process.env.LAUNCHER_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

async function fetchJson(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = parseJson(text);

    if (!response.ok) {
      return {
        status: "unhealthy",
        url,
        http_status: response.status,
        error: `HTTP ${response.status}`,
      };
    }

    return { status: "reachable", url, http_status: response.status, payload };
  } catch (error) {
    return { status: "unreachable", url, error: compactError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function checkPorts(opts) {
  return Promise.all(
    PORTS.map(async (entry) => {
      const listeners = await listenersForPort(entry.port, opts.timeoutMs);
      const status = listeners.length > 0 ? "listening" : "not_listening";
      const expectedOwner =
        entry.expected.length === 0 ||
        listeners.some((listener) =>
          entry.expected.some((expected) => listener.command.toLowerCase().includes(expected.toLowerCase())),
        );

      return {
        ...entry,
        status,
        expected_owner: listeners.length === 0 ? null : expectedOwner,
        listeners,
      };
    }),
  );
}

async function listenersForPort(port, timeoutMs) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: timeoutMs,
    });
    const pids = stdout
      .split(/\s+/)
      .map((pid) => pid.trim())
      .filter(Boolean);

    return Promise.all(
      pids.map(async (pid) => {
        const command = await commandForPid(pid, timeoutMs);
        return { pid: Number(pid), command };
      }),
    );
  } catch {
    return [];
  }
}

async function commandForPid(pid, timeoutMs) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", pid, "-o", "command="], { timeout: timeoutMs });
    return redact(stdout.trim());
  } catch {
    return "unknown";
  }
}

async function checkLogs(opts) {
  const now = Date.now();

  return Promise.all(
    LOGS.map(async (log) => {
      const absolutePath = path.join(ROOT_DIR, log.path);
      try {
        const info = await stat(absolutePath);
        const ageMs = now - info.mtimeMs;
        return {
          service: log.service,
          path: log.path,
          status: ageMs <= opts.logStaleMs ? "fresh" : "stale",
          age_ms: Math.max(0, Math.round(ageMs)),
          size_bytes: info.size,
          mtime: info.mtime.toISOString(),
        };
      } catch (error) {
        return {
          service: log.service,
          path: log.path,
          status: "missing",
          error: compactError(error),
        };
      }
    }),
  );
}

async function checkEnvFiles() {
  const candidates = await Promise.all(
    ENV_CANDIDATES.map(async (candidate) => {
      const displayPath = path.isAbsolute(candidate) ? candidate : candidate;
      const absolutePath = path.isAbsolute(candidate) ? candidate : path.join(ROOT_DIR, candidate);
      const present = await fileExists(absolutePath);
      return { path: displayPath, present };
    }),
  );

  return {
    status: candidates.some((candidate) => candidate.present) ? "present" : "missing",
    candidates,
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function collectFailures({ cli, services, localRuntime, ports, opts }) {
  const failures = [];

  for (const entry of cli.entries) {
    if (entry.status === "missing") failures.push({ code: "cli_missing", subject: entry.name });
  }

  if (services.launcher.status === "unreachable") {
    failures.push({ code: "launcher_unreachable", subject: "launcher" });
  } else if (services.launcher.status !== "healthy") {
    failures.push({ code: "launcher_unhealthy", subject: "launcher" });
  }

  if (services.launcher.database && services.launcher.database.connected !== true) {
    failures.push({ code: "launcher_database_disconnected", subject: "launcher database" });
  }

  if (services.orchestrator.status === "unreachable") {
    failures.push({ code: "orchestrator_unreachable", subject: "orchestrator" });
  } else if (services.orchestrator.status !== "healthy") {
    failures.push({ code: "orchestrator_unhealthy", subject: "orchestrator" });
  }

  for (const port of ports) {
    if (port.required && port.status === "listening" && port.expected_owner === false) {
      failures.push({ code: "port_collision", subject: String(port.port), data: { port: port.port } });
    }
  }

  if (opts.workspaceId && localRuntime.status !== "healthy") {
    failures.push({
      code: "local_runtime_not_ready",
      subject: opts.workspaceId,
      data: { workspace_id: opts.workspaceId },
    });
  }

  return failures;
}

function collectWarnings({ logs, env }) {
  const warnings = [];

  if (env.status === "missing") warnings.push({ code: "env_missing", subject: ".env" });

  for (const log of logs) {
    if (log.status === "missing") warnings.push({ code: "log_missing", subject: log.path });
    if (log.status === "stale") warnings.push({ code: "log_stale", subject: log.path });
  }

  return warnings;
}

function explainFailure(item, catalog) {
  const details = catalog[item.code] ?? {};
  return {
    code: item.code,
    subject: item.subject,
    symptom: details.symptom ?? item.code,
    likely_cause: details.likely_cause ?? "Unknown.",
    next_steps: substituteNextSteps(details.next_steps ?? [], item.data ?? {}),
  };
}

function nextStepsFor(items, catalog) {
  const steps = [];
  const seen = new Set();

  for (const item of items) {
    const details = catalog[item.code];
    for (const step of substituteNextSteps(details?.next_steps ?? [], item.data ?? {})) {
      if (!seen.has(step)) {
        seen.add(step);
        steps.push(step);
      }
    }
  }

  return steps;
}

function substituteNextSteps(steps, data) {
  return steps.map((step) =>
    step
      .replaceAll("<port>", String(data.port ?? "<port>"))
      .replaceAll("<workspace-id>", String(data.workspace_id ?? "<workspace-id>")),
  );
}

function printSummary(result) {
  console.log(`[runtime-doctor] ${result.ok ? "ok" : "unhealthy"}`);
  console.log("");
  console.log("CLIs:");
  for (const entry of result.cli.entries) {
    console.log(`  ${statusMark(entry.status === "present")} ${entry.name}: ${entry.status}`);
  }

  console.log("");
  console.log("Services:");
  printService(result.services.launcher);
  printService(result.services.orchestrator);

  if (result.local_runtime.filters?.workspace_id) {
    console.log("");
    console.log("Local runtime:");
    console.log(
      `  ${statusMark(result.local_runtime.status === "healthy")} helper: ${result.local_runtime.status}, reason=${result.local_runtime.reason ?? "ready"}, helpers=${result.local_runtime.helpers.length}`,
    );
  }

  console.log("");
  console.log("Ports:");
  for (const port of result.ports) {
    const owner = port.listeners.map((listener) => `${listener.pid} ${listener.command}`).join("; ") || "none";
    console.log(`  ${statusMark(port.status === "listening" || !port.required)} ${port.port} ${port.service}: ${port.status} (${owner})`);
  }

  console.log("");
  console.log("Logs:");
  for (const log of result.logs) {
    const detail = log.status === "fresh" || log.status === "stale" ? `${log.status}, ${formatAge(log.age_ms)} old` : log.status;
    console.log(`  ${statusMark(log.status === "fresh")} ${log.path}: ${detail}`);
  }

  console.log("");
  console.log(`Env file: ${result.env.status}`);

  if (result.failures.length > 0 || result.warnings.length > 0) {
    console.log("");
    console.log("Findings:");
    for (const failure of result.failures) {
      console.log(`  ! ${failure.subject}: ${failure.likely_cause}`);
    }
    for (const warning of result.warnings) {
      console.log(`  - ${warning.subject}: ${warning.likely_cause}`);
    }
  }

  if (result.next_steps.length > 0) {
    console.log("");
    console.log("Next steps:");
    for (const step of result.next_steps) {
      console.log(`  ${step}`);
    }
  }
}

function printService(service) {
  let detail = service.status;
  if (service.database) detail += `, database=${service.database.status}`;
  if (service.error) detail += ` (${service.error})`;
  console.log(`  ${statusMark(service.status === "healthy")} ${service.service}: ${detail}`);
}

function statusMark(ok) {
  return ok ? "ok" : "!!";
}

function formatAge(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function compactError(error) {
  if (error?.name === "AbortError") return "timeout";
  if (error?.code) return redact(String(error.code));
  if (error?.message) return redact(error.message);
  return redact(String(error));
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function redact(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|password|service[_-]?role[_-]?key)=([^,\s]+)/gi, "$1=[REDACTED]")
    .replace(/(sk|pk|rk|sess)-[A-Za-z0-9_-]{16,}/g, "$1-[REDACTED]");
}

main().catch((error) => {
  console.error(`[runtime-doctor] failed: ${error.message}`);
  process.exit(1);
});
