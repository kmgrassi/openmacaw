#!/usr/bin/env node

const DEFAULT_LAUNCHER_URL = "http://127.0.0.1:4100";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_TICK_AGE_MS = 10 * 60_000;

function parseArgs(argv) {
  const opts = {
    launcherUrl: process.env.LAUNCHER_URL || DEFAULT_LAUNCHER_URL,
    workspaceId: process.env.MANAGER_WORKSPACE_ID || "",
    agentId: process.env.MANAGER_AGENT_ID || "",
    timeoutMs: numberFromEnv("MANAGER_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pollIntervalMs: numberFromEnv("MANAGER_SMOKE_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    maxTickAgeMs: numberFromEnv("MANAGER_SMOKE_MAX_TICK_AGE_MS", DEFAULT_MAX_TICK_AGE_MS),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--workspace-id" && next) {
      opts.workspaceId = next;
      i += 1;
    } else if (arg === "--agent-id" && next) {
      opts.agentId = next;
      i += 1;
    } else if (arg === "--launcher-url" && next) {
      opts.launcherUrl = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = parsePositiveInt(next, "--timeout-ms");
      i += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      opts.pollIntervalMs = parsePositiveInt(next, "--poll-interval-ms");
      i += 1;
    } else if (arg === "--max-tick-age-ms" && next) {
      opts.maxTickAgeMs = parsePositiveInt(next, "--max-tick-age-ms");
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  opts.launcherUrl = opts.launcherUrl.replace(/\/+$/, "");
  opts.workspaceId = opts.workspaceId.trim();
  opts.agentId = opts.agentId.trim();
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
  console.log(`Usage: pnpm smoke:manager -- --workspace-id <workspace-id>

Options:
  --workspace-id <id>       Workspace whose manager scheduler should be healthy.
  --agent-id <id>           Expected manager agent id for the workspace.
  --launcher-url <url>      Launcher base URL. Default: ${DEFAULT_LAUNCHER_URL}
  --timeout-ms <ms>         Poll timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --poll-interval-ms <ms>   Poll interval. Default: ${DEFAULT_POLL_INTERVAL_MS}
  --max-tick-age-ms <ms>    Max accepted age for last_tick_at. Default: ${DEFAULT_MAX_TICK_AGE_MS}

Environment:
  MANAGER_WORKSPACE_ID, MANAGER_AGENT_ID, LAUNCHER_URL,
  MANAGER_SMOKE_TIMEOUT_MS, MANAGER_SMOKE_POLL_INTERVAL_MS,
  MANAGER_SMOKE_MAX_TICK_AGE_MS`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.workspaceId) {
    throw new Error("workspace id is required. Pass --workspace-id or set MANAGER_WORKSPACE_ID.");
  }

  await checkLauncherHealth(opts.launcherUrl);
  const status = await waitForManager(opts);

  console.log("[manager-smoke] manager is healthy");
  console.log(
    JSON.stringify(
      {
        workspace_id: status.workspace_id,
        agent_id: status.agent_id,
        provider: status.provider,
        model: status.model,
        last_tick_at: status.last_tick_at,
        last_decision_count: status.last_decision_count,
      },
      null,
      2,
    ),
  );
}

async function checkLauncherHealth(launcherUrl) {
  const health = await fetchJson(`${launcherUrl}/health`);

  if (health.ok !== true) {
    throw new Error(`launcher health is not ok: ${JSON.stringify(health)}`);
  }

  console.log("[manager-smoke] launcher healthy");
}

async function waitForManager(opts) {
  const deadline = Date.now() + opts.timeoutMs;
  let lastStatus = null;

  while (Date.now() <= deadline) {
    lastStatus = await managerStatus(opts.launcherUrl, opts.workspaceId, opts.agentId);
    const error = managerReadinessError(lastStatus, opts.maxTickAgeMs);

    if (!error) {
      return lastStatus;
    }

    console.log(`[manager-smoke] waiting: ${error}`);
    await sleep(opts.pollIntervalMs);
  }

  throw new Error(`manager did not become healthy before timeout. Last status: ${JSON.stringify(lastStatus)}`);
}

async function managerStatus(launcherUrl, workspaceId, agentId) {
  const url = new URL("/api/runtime/manager-status", launcherUrl);
  url.searchParams.set("workspace_id", workspaceId);
  if (agentId) url.searchParams.set("agent_id", agentId);
  return fetchJson(url.href);
}

function managerReadinessError(status, maxTickAgeMs) {
  if (!status || typeof status !== "object") return "manager status response is empty";
  if (status.status !== "running") return `status=${status.status}`;
  if (Array.isArray(status.missing) && status.missing.length > 0) return `missing=${status.missing.join(",")}`;
  if (status.last_error) return `last_error=${status.last_error.message || JSON.stringify(status.last_error)}`;
  if (!status.provider) return "provider is missing";
  if (!status.model) return "model is missing";
  if (!status.credential_id) return "credential_id is missing";
  if (!status.last_tick_at) return "last_tick_at is missing";

  const tickAgeMs = Date.now() - Date.parse(status.last_tick_at);
  if (!Number.isFinite(tickAgeMs)) return `last_tick_at is invalid: ${status.last_tick_at}`;
  if (tickAgeMs > maxTickAgeMs) return `last_tick_at is stale: ${status.last_tick_at}`;

  return null;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${text}`);
  }

  return body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`[manager-smoke] failed: ${error.message}`);
  process.exit(1);
});
