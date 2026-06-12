#!/usr/bin/env node

const DEFAULT_LAUNCHER_URL = "http://127.0.0.1:4100";
const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:4000";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RECENT_FAILURE_WINDOW_MS = 5 * 60_000;
const SECRET_KEY_PATTERN =
  /(^|_|\b)(api[_-]?key|authorization|bearer|credential|password|secret|service[_-]?role|token)(_|$|\b)/i;

function parseArgs(argv) {
  const opts = {
    launcherUrl: process.env.LAUNCHER_URL || DEFAULT_LAUNCHER_URL,
    orchestratorUrl: process.env.ORCHESTRATOR_URL || DEFAULT_ORCHESTRATOR_URL,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || process.env.MANAGER_WORKSPACE_ID || "",
    agentId: process.env.MANAGER_AGENT_ID || "",
    targetRunnerKind: process.env.RUNTIME_TARGET_RUNNER_KIND || "openai_compatible",
    model: process.env.RUNTIME_MODEL || "",
    timeoutMs: numberFromEnv("RUNTIME_SNAPSHOT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    recentFailureWindowMs: numberFromEnv(
      "RUNTIME_SNAPSHOT_RECENT_FAILURE_WINDOW_MS",
      DEFAULT_RECENT_FAILURE_WINDOW_MS,
    ),
    json: false,
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
    } else if (arg === "--agent-id" && next) {
      opts.agentId = next;
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
    } else if (arg === "--recent-failure-window-ms" && next) {
      opts.recentFailureWindowMs = parseNonNegativeInt(next, "--recent-failure-window-ms");
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
  opts.agentId = opts.agentId.trim();
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

function parseNonNegativeInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: pnpm snapshot:runtime [-- --json]

Options:
  --json                    Print the full machine-readable snapshot.
  --launcher-url <url>      Launcher base URL. Default: ${DEFAULT_LAUNCHER_URL}
  --orchestrator-url <url>  Orchestrator base URL. Default: ${DEFAULT_ORCHESTRATOR_URL}
  --workspace-id <id>       Include manager status for this workspace.
  --agent-id <id>           Narrow manager status to a configured manager agent.
  --target-runner-kind <kind>
                            Include local helper readiness for this runner kind.
                            Default: openai_compatible
  --model <name>            Require this local model in helper diagnostics.
  --timeout-ms <ms>         Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --recent-failure-window-ms <ms>
                            Treat launcher latest_failure as recent for this
                            long when current health is recovered. Default: ${DEFAULT_RECENT_FAILURE_WINDOW_MS}

Environment:
  LAUNCHER_URL, ORCHESTRATOR_URL, RUNTIME_WORKSPACE_ID, MANAGER_WORKSPACE_ID,
  MANAGER_AGENT_ID, RUNTIME_TARGET_RUNNER_KIND, RUNTIME_MODEL,
  RUNTIME_SNAPSHOT_TIMEOUT_MS, RUNTIME_SNAPSHOT_RECENT_FAILURE_WINDOW_MS`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const snapshot = await buildSnapshot(opts);

  if (opts.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    printSummary(snapshot);
  }

  process.exitCode = snapshot.ok ? 0 : 1;
}

async function buildSnapshot(opts) {
  const generatedAt = new Date().toISOString();
  const [launcherHealth, launcherOrchestrators, orchestratorHealth, orchestratorState, managerStatus, localRuntimeHealth] =
    await Promise.all([
      captureJson(`${opts.launcherUrl}/health`, opts.timeoutMs),
      captureJson(`${opts.launcherUrl}/orchestrators`, opts.timeoutMs),
      captureJson(`${opts.orchestratorUrl}/api/v1/health`, opts.timeoutMs),
      captureJson(`${opts.orchestratorUrl}/api/v1/state`, opts.timeoutMs, serviceRoleHeaders()),
      opts.workspaceId ? captureJson(managerStatusUrl(opts), opts.timeoutMs) : Promise.resolve(null),
      opts.workspaceId
        ? captureJson(localRuntimeHealthUrl(opts), opts.timeoutMs, serviceRoleHeaders())
        : Promise.resolve(null),
    ]);

  const services = {
    launcher: launcherService(opts.launcherUrl, launcherHealth),
    orchestrator: orchestratorService(opts.orchestratorUrl, orchestratorHealth, orchestratorState),
  };

  const orchestrators = launcherOrchestrators.ok
    ? arrayValue(launcherOrchestrators.body?.data).map(orchestratorSummary)
    : [];

  const manager = managerStatus ? managerSummary(managerStatus) : null;
  const localRuntime = localRuntimeHealth ? localRuntimeSummary(localRuntimeHealth) : null;
  const failures = recentFailures({
    opts,
    services,
    launcherHealth,
    launcherOrchestrators,
    orchestratorHealth,
    orchestratorState,
    managerStatus,
    localRuntimeHealth,
  });
  const routing = routingSummary({ opts, orchestrators, localRuntime });
  const nextSteps = nextStepsFor({ opts, services, manager, localRuntime, routing, failures });

  return {
    schema_version: 1,
    ok: services.launcher.status === "healthy" && services.orchestrator.status === "healthy" && failures.length === 0,
    generated_at: generatedAt,
    services,
    active_runtime: {
      counts: stateCounts(orchestratorState),
      running: stateEntries(orchestratorState, "running"),
      retrying: stateEntries(orchestratorState, "retrying"),
      orchestrators,
    },
    repo_cache: repoCacheSummary(orchestratorState),
    manager,
    local_runtime: localRuntime,
    routing,
    execution_profiles: executionProfiles(orchestrators),
    recent_failures: failures,
    inspect: {
      health: {
        launcher: `${opts.launcherUrl}/health`,
        orchestrator: `${opts.orchestratorUrl}/api/v1/health`,
      },
      state: `${opts.orchestratorUrl}/api/v1/state`,
      manager_status: opts.workspaceId ? managerStatusUrl(opts) : null,
      local_runtime_health: opts.workspaceId ? localRuntimeHealthUrl(opts) : null,
      commands: nextSteps,
    },
  };
}

// /api/v1/state and /api/v1/local-runtime/* sit behind RequireServiceRoleBearer.
function serviceRoleHeaders() {
  const key = (process.env.LAUNCHER_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

async function captureJson(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    return {
      ok: response.ok,
      status: response.status,
      url,
      body: sanitize(body),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      url,
      body: null,
      error: error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function launcherService(baseUrl, result) {
  const body = result.body || {};
  const database = body.database || null;
  const databaseConnected = database?.connected === true;

  return {
    status: result.ok && body.ok === true && databaseConnected ? "healthy" : "unhealthy",
    url: `${baseUrl}/health`,
    database: database
      ? {
          connected: databaseConnected,
          status: database.status || "unknown",
        }
      : null,
    lifecycle: body.lifecycle || null,
    error: result.ok ? null : result.error,
  };
}

function orchestratorService(baseUrl, healthResult, stateResult) {
  const health = healthResult.body || {};
  const healthy =
    healthResult.ok && (health.ok === true || health.status === "ok" || health.status === "healthy");

  return {
    status: healthy ? "healthy" : "unhealthy",
    url: `${baseUrl}/api/v1/health`,
    health: healthResult.ok ? health : null,
    state_available: stateResult.ok,
    error: healthResult.ok ? null : healthResult.error,
  };
}

function stateCounts(result) {
  if (!result.ok || !result.body) return { running: 0, retrying: 0 };
  return {
    running: numberOrZero(result.body.counts?.running),
    retrying: numberOrZero(result.body.counts?.retrying),
  };
}

function stateEntries(result, key) {
  if (!result.ok || !result.body) return [];
  return arrayValue(result.body[key]).map((entry) => sanitize(entry));
}

function repoCacheSummary(result) {
  const repoCache = result.ok && result.body ? result.body.repo_cache || {} : {};

  return {
    repositories: arrayValue(repoCache.repositories).map((entry) => sanitize(entry)),
    active_workspaces: arrayValue(repoCache.active_workspaces).map((entry) => sanitize(entry)),
  };
}

function orchestratorSummary(entry) {
  return {
    id: entry.id,
    agent_id: entry.agent_id || null,
    agent_name: entry.agent_name || null,
    type: entry.type || null,
    workspace_id: entry.workspace_id || null,
    project_id: entry.project_id || null,
    port: entry.port || null,
    status: entry.status || "unknown",
    started_at: entry.started_at || null,
    restart_count: numberOrZero(entry.restart_count),
    execution_profile: sanitize(extractExecutionProfile(entry.config)),
  };
}

function managerSummary(result) {
  if (!result.ok) {
    return {
      status: "unavailable",
      error: result.error,
    };
  }

  const body = result.body || {};
  return {
    status: body.status || "unknown",
    workspace_id: body.workspace_id || null,
    agent_id: body.agent_id || null,
    provider: body.provider || null,
    model: body.model || null,
    scheduler_health: body.scheduler_health || null,
    last_tick_at: body.last_tick_at || null,
    last_error: body.last_error || null,
    missing: arrayValue(body.missing),
  };
}

function localRuntimeSummary(result) {
  if (!result.ok) {
    return {
      status: "unavailable",
      reason: result.error,
      helpers: [],
    };
  }

  const body = result.body || {};
  return {
    ok: body.ok === true,
    status: body.status || "unknown",
    reason: body.reason || null,
    missing_capabilities: arrayValue(body.missing_capabilities),
    filters: body.filters || {},
    helpers: arrayValue(body.helpers),
  };
}

function routingSummary({ opts, orchestrators, localRuntime }) {
  if (!opts.workspaceId && !opts.agentId) {
    return {
      status: "not_checked",
      reason: "pass --workspace-id and optionally --agent-id to check local runtime routing",
    };
  }

  const matchingProfiles = executionProfiles(orchestrators).filter((entry) => {
    if (opts.workspaceId && entry.workspace_id !== opts.workspaceId) return false;
    if (opts.agentId && entry.agent_id !== opts.agentId) return false;
    return true;
  });

  const localRelayProfiles = matchingProfiles.filter((entry) => entry.profile?.runner_kind === "local_relay");

  if (matchingProfiles.length === 0) {
    return {
      status: "unknown",
      reason: "no launched orchestrator profile matched the requested workspace or agent",
      matching_profiles: [],
    };
  }

  if (localRelayProfiles.length === 0) {
    return {
      status: "cloud_or_non_local",
      reason: "matching profiles do not route to local_relay",
      matching_profiles: matchingProfiles,
    };
  }

  if (!localRuntime || localRuntime.ok !== true) {
    return {
      status: "blocked",
      reason: localRuntime?.reason || "local helper is not ready",
      matching_profiles: localRelayProfiles,
    };
  }

  return {
    status: "local_relay_ready",
    reason: "matching profile routes to local_relay and a helper is ready",
    matching_profiles: localRelayProfiles,
  };
}

function executionProfiles(orchestrators) {
  return orchestrators
    .filter((entry) => entry.execution_profile && Object.keys(entry.execution_profile).length > 0)
    .map((entry) => ({
      orchestrator_id: entry.id,
      agent_id: entry.agent_id,
      workspace_id: entry.workspace_id,
      profile: entry.execution_profile,
    }));
}

function extractExecutionProfile(config) {
  if (!config || typeof config !== "object") return {};
  return (
    config.execution_profile ||
    config.resolved_execution_profile ||
    config.runtime?.execution_profile ||
    {}
  );
}

function recentFailures({
  opts,
  services,
  launcherHealth,
  launcherOrchestrators,
  orchestratorHealth,
  orchestratorState,
  managerStatus,
  localRuntimeHealth,
}) {
  const failures = [];

  for (const result of [
    launcherHealth,
    launcherOrchestrators,
    orchestratorHealth,
    orchestratorState,
    managerStatus,
    localRuntimeHealth,
  ].filter(Boolean)) {
    if (!result.ok) {
      failures.push({
        category: "http",
        url: result.url,
        status: result.status,
        message: result.error,
      });
    }
  }

  const launcherHealthBody = launcherHealth?.body || {};
  const latestFailure = launcherHealthBody.lifecycle?.latest_failure;
  if (latestFailure && shouldReportLauncherFailure(latestFailure, services.launcher, opts.recentFailureWindowMs)) {
    failures.push({
      category: latestFailure.failure_category || "launcher",
      event: latestFailure.event || null,
      message: latestFailure.error_message || latestFailure.reason || "launcher reported a recent failure",
      trace_id: latestFailure.trace_id || null,
      occurred_at: latestFailure.occurred_at || latestFailure.timestamp || null,
    });
  }

  const managerBody = managerStatus?.body || {};
  if (managerBody.last_error) {
    failures.push({
      category: "manager",
      message: managerBody.last_error.message || JSON.stringify(managerBody.last_error),
      trace_id: managerBody.trace_id || null,
    });
  }

  const localRuntimeBody = localRuntimeHealth?.body || {};
  if (localRuntimeHealth && localRuntimeHealth.ok && localRuntimeBody.ok !== true) {
    failures.push({
      category: "local_runtime",
      message: localRuntimeBody.reason || "local helper is not ready",
    });
  }

  return failures.map((failure) => sanitize(failure));
}

function shouldReportLauncherFailure(latestFailure, launcher, recentFailureWindowMs) {
  if (launcher.status !== "healthy") return true;
  if (recentFailureWindowMs === 0) return false;

  const occurredAt = latestFailure.occurred_at || latestFailure.timestamp;
  const occurredMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredMs)) return false;

  return Date.now() - occurredMs <= recentFailureWindowMs;
}

function nextStepsFor({ opts, services, manager, localRuntime, routing, failures }) {
  const commands = [];

  if (services.launcher.status !== "healthy" || services.orchestrator.status !== "healthy") {
    commands.push("pnpm run start:local");
  }

  if (services.launcher.status !== "healthy") {
    commands.push(`curl ${opts.launcherUrl}/health`);
  }

  if (services.orchestrator.status !== "healthy") {
    commands.push(`curl ${opts.orchestratorUrl}/api/v1/health`);
  }

  if (opts.workspaceId && manager && manager.status !== "running") {
    commands.push(`pnpm run smoke:manager -- --workspace-id ${opts.workspaceId}`);
  }

  if (opts.workspaceId && localRuntime && localRuntime.ok !== true) {
    commands.push(`pnpm run smoke:local-relay -- --workspace-id ${opts.workspaceId}`);
  }

  if (routing?.status === "cloud_or_non_local") {
    commands.push("check the selected agent execution profile; it is not routing to local_relay");
  }

  if (failures.length > 0) {
    commands.push("pnpm run logs:runtime -- --level error");
  }

  if (commands.length === 0) {
    commands.push("pnpm run smoke:runtime");
  }

  return [...new Set(commands)];
}

function managerStatusUrl(opts) {
  const url = new URL("/api/runtime/manager-status", opts.launcherUrl);
  url.searchParams.set("workspace_id", opts.workspaceId);
  if (opts.agentId) url.searchParams.set("agent_id", opts.agentId);
  return url.href;
}

function localRuntimeHealthUrl(opts) {
  const url = new URL("/api/v1/local-runtime/health", opts.orchestratorUrl);
  url.searchParams.set("workspace_id", opts.workspaceId);
  if (opts.targetRunnerKind) url.searchParams.set("target_runner_kind", opts.targetRunnerKind);
  if (opts.model) url.searchParams.set("model", opts.model);
  return url.href;
}

function printSummary(snapshot) {
  const status = snapshot.ok ? "ok" : "needs attention";
  console.log(`[runtime-snapshot] ${status}`);
  console.log(`launcher: ${snapshot.services.launcher.status} (${snapshot.services.launcher.url})`);
  console.log(`orchestrator: ${snapshot.services.orchestrator.status} (${snapshot.services.orchestrator.url})`);

  const db = snapshot.services.launcher.database;
  if (db) {
    console.log(`database: ${db.connected ? "connected" : "not connected"} (${db.status})`);
  }

  console.log(
    `active runtime: running=${snapshot.active_runtime.counts.running} retrying=${snapshot.active_runtime.counts.retrying} orchestrators=${snapshot.active_runtime.orchestrators.length}`,
  );
  console.log(
    `repo cache: warm=${snapshot.repo_cache.repositories.length} active_workspaces=${snapshot.repo_cache.active_workspaces.length}`,
  );

  if (snapshot.manager) {
    console.log(
      `manager: ${snapshot.manager.status} workspace=${snapshot.manager.workspace_id || "unknown"} agent=${snapshot.manager.agent_id || "unknown"}`,
    );
  }

  if (snapshot.local_runtime) {
    console.log(
      `local runtime: ${snapshot.local_runtime.status} reason=${snapshot.local_runtime.reason || "ready"} helpers=${snapshot.local_runtime.helpers.length}`,
    );
  }

  if (snapshot.routing && snapshot.routing.status !== "not_checked") {
    console.log(`routing: ${snapshot.routing.status} (${snapshot.routing.reason})`);
  }

  if (snapshot.execution_profiles.length > 0) {
    console.log(`execution profiles: ${snapshot.execution_profiles.length} configured`);
  }

  if (snapshot.recent_failures.length > 0) {
    console.log("recent failures:");
    for (const failure of snapshot.recent_failures) {
      console.log(`- ${failure.category}: ${failure.message || failure.error || "unknown failure"}`);
    }
  }

  console.log("next commands:");
  for (const command of snapshot.inspect.commands) {
    console.log(`- ${command}`);
  }
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (SECRET_KEY_PATTERN.test(key)) return [key, "[REDACTED]"];
      return [key, sanitize(entry)];
    }),
  );
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(`[runtime-snapshot] failed: ${error.message}`);
  process.exit(1);
});
