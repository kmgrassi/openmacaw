#!/usr/bin/env node

const DEFAULT_LAUNCHER_URL = "http://127.0.0.1:4100";
const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:4000";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function parseArgs(argv) {
  const opts = {
    launcherUrl: process.env.LAUNCHER_URL || DEFAULT_LAUNCHER_URL,
    orchestratorUrl: process.env.ORCHESTRATOR_URL || DEFAULT_ORCHESTRATOR_URL,
    timeoutMs: numberFromEnv("RUNTIME_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pollIntervalMs: numberFromEnv("RUNTIME_SMOKE_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--launcher-url" && next) {
      opts.launcherUrl = next;
      i += 1;
    } else if (arg === "--orchestrator-url" && next) {
      opts.orchestratorUrl = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = parsePositiveInt(next, "--timeout-ms");
      i += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      opts.pollIntervalMs = parsePositiveInt(next, "--poll-interval-ms");
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  opts.launcherUrl = opts.launcherUrl.replace(/\/+$/, "");
  opts.orchestratorUrl = opts.orchestratorUrl.replace(/\/+$/, "");
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
  console.log(`Usage: pnpm smoke:runtime

Options:
  --launcher-url <url>       Launcher base URL. Default: ${DEFAULT_LAUNCHER_URL}
  --orchestrator-url <url>   Orchestrator base URL. Default: ${DEFAULT_ORCHESTRATOR_URL}
  --timeout-ms <ms>          Poll timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --poll-interval-ms <ms>    Poll interval. Default: ${DEFAULT_POLL_INTERVAL_MS}

Environment:
  LAUNCHER_URL, ORCHESTRATOR_URL, RUNTIME_SMOKE_TIMEOUT_MS,
  RUNTIME_SMOKE_POLL_INTERVAL_MS, RUNTIME_SMOKE_REQUIRE_DATABASE=0`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + opts.timeoutMs;

  const launcher = await waitFor("launcher", `${opts.launcherUrl}/health`, deadline, opts.pollIntervalMs, (payload) => {
    if (payload.ok !== true) return `ok=${payload.ok}`;
    return null;
  });

  const orchestrator = await waitFor(
    "orchestrator",
    `${opts.orchestratorUrl}/api/v1/health`,
    deadline,
    opts.pollIntervalMs,
    (payload) => {
      if (payload.ok === true) return null;
      if (payload.status === "ok" || payload.status === "healthy") return null;
      return `unexpected payload=${JSON.stringify(payload)}`;
    },
  );

  console.log("[runtime-smoke] runtime is healthy");
  console.log(
    JSON.stringify(
      {
        launcher: {
          service: launcher.service,
        },
        orchestrator: {
          status: orchestrator.status ?? (orchestrator.ok === true ? "ok" : "unknown"),
        },
      },
      null,
      2,
    ),
  );
}

async function waitFor(name, url, deadline, pollIntervalMs, validate) {
  let lastError = "not checked";

  while (Date.now() <= deadline) {
    try {
      const payload = await fetchJson(url);
      const error = validate(payload);
      if (!error) return payload;
      lastError = error;
    } catch (error) {
      lastError = error.message;
    }

    console.log(`[runtime-smoke] waiting for ${name}: ${lastError}`);
    await sleep(pollIntervalMs);
  }

  throw new Error(`${name} did not become healthy before timeout: ${lastError}`);
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
  console.error(`[runtime-smoke] failed: ${error.message}`);
  process.exit(1);
});
