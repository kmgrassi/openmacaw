#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const DEFAULT_LAUNCHER_URL = "http://127.0.0.1:4100";
const DEFAULT_FIXTURE = "fixtures/work-items/manager-dispatch.json";
const DEFAULT_TICK_TIMEOUT_MS = 305_000;
const SELECT_WORK_ITEM =
  "id,workspace_id,manager_runner_id,title,state,source,metadata,next_poll_at,last_polled_at,updated_at";

loadDotEnv(path.resolve(process.cwd(), ".env"));

function parseArgs(argv) {
  const opts = {
    launcherUrl: process.env.LAUNCHER_URL || DEFAULT_LAUNCHER_URL,
    workspaceId: process.env.MANAGER_WORKSPACE_ID || "",
    agentId: process.env.MANAGER_AGENT_ID || "",
    fixturePath: DEFAULT_FIXTURE,
    json: false,
    keepWorkItem: false,
    tickTimeoutMs: numberFromEnv("MANAGER_DISPATCH_SMOKE_TICK_TIMEOUT_MS", DEFAULT_TICK_TIMEOUT_MS),
    supabaseUrl:
      process.env.LAUNCHER_SUPABASE_URL || process.env.SUPABASE_URL || "",
    supabaseKey:
      process.env.LAUNCHER_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
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
    } else if (arg === "--work-item-fixture" && next) {
      opts.fixturePath = next;
      i += 1;
    } else if (arg === "--launcher-url" && next) {
      opts.launcherUrl = next;
      i += 1;
    } else if (arg === "--supabase-url" && next) {
      opts.supabaseUrl = next;
      i += 1;
    } else if (arg === "--tick-timeout-ms" && next) {
      opts.tickTimeoutMs = parsePositiveInt(next, "--tick-timeout-ms");
      i += 1;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--keep-work-item") {
      opts.keepWorkItem = true;
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
  opts.supabaseUrl = opts.supabaseUrl.trim();
  opts.supabaseKey = opts.supabaseKey.trim();
  return opts;
}

function printUsage() {
  console.log(`Usage: pnpm run smoke:manager-dispatch -- \\
  --workspace-id <workspace-id> \\
  --agent-id <manager-agent-id> \\
  --work-item-fixture ${DEFAULT_FIXTURE} \\
  --json

Options:
  --workspace-id <id>        Workspace whose manager should dispatch due work.
  --agent-id <id>            Manager agent id expected to own the work item.
  --work-item-fixture <path> Fixture for the disposable work_items row.
  --launcher-url <url>       Launcher base URL. Default: ${DEFAULT_LAUNCHER_URL}
  --supabase-url <url>       Supabase project URL or /rest/v1 endpoint.
  --tick-timeout-ms <ms>     Forced manager tick timeout. Default: ${DEFAULT_TICK_TIMEOUT_MS}
  --json                     Print only machine-readable JSON.
  --keep-work-item           Leave the disposable work item behind for debugging.

Environment:
  MANAGER_WORKSPACE_ID, MANAGER_AGENT_ID, LAUNCHER_URL,
  LAUNCHER_SUPABASE_URL or SUPABASE_URL,
  LAUNCHER_SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY`);
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  validateOpts(opts);

  const fixture = readFixture(opts.fixturePath);
  const client = supabaseClient(opts);

  await checkLauncherHealth(opts.launcherUrl, opts.json);
  const beforeStatus = await managerStatus(opts.launcherUrl, opts.workspaceId, opts.agentId);
  failOnManagerError(beforeStatus);

  const created = await createWorkItem(client, fixture, opts);
  let finalWorkItem = null;
  let tick = null;
  let messages = [];
  let assertion = null;

  try {
    tick = await forceManagerTick(opts);
    failOnManagerError(tick);

    finalWorkItem = await fetchWorkItem(client, created.id);
    const runId = firstRunId(tick);
    messages = runId ? await fetchRunMessages(client, runId, opts) : [];
    assertion = assertDispatchEvidence({
      fixture,
      created,
      finalWorkItem,
      tick,
      messages,
      beforeStatus,
    });

    const summary = summaryPayload({
      opts,
      fixture,
      created,
      finalWorkItem,
      beforeStatus,
      tick,
      messages,
      assertion,
    });

    printSummary(summary, opts.json);
  } finally {
    if (!opts.keepWorkItem && created?.id) {
      await deleteWorkItem(client, created.id).catch((error) => {
        if (!opts.json) {
          console.error(`[manager-dispatch-smoke] cleanup failed: ${error.message}`);
        }
      });
    }
  }
}

function validateOpts(opts) {
  if (!opts.workspaceId) throw new Error("workspace id is required. Pass --workspace-id.");
  if (!opts.agentId) throw new Error("manager agent id is required. Pass --agent-id.");
  if (!opts.supabaseUrl) {
    throw new Error("Supabase URL is required. Set SUPABASE_URL or pass --supabase-url.");
  }
  if (!opts.supabaseKey) {
    throw new Error("Supabase service role key is required. Set SUPABASE_SERVICE_ROLE_KEY.");
  }
}

function readFixture(fixturePath) {
  const resolved = path.resolve(process.cwd(), fixturePath);
  const fixture = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error(`fixture must be a JSON object: ${fixturePath}`);
  }
  return fixture;
}

function supabaseClient(opts) {
  return {
    endpoint: restEndpoint(opts.supabaseUrl),
    apiKey: opts.supabaseKey,
  };
}

function restEndpoint(value) {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/rest/v1") ? trimmed : `${trimmed}/rest/v1`;
}

async function checkLauncherHealth(launcherUrl, json) {
  const health = await fetchJson(`${launcherUrl}/health`);
  if (health.ok !== true) {
    throw new Error(`launcher health is not ok: ${JSON.stringify(health)}`);
  }
  if (!health.database || health.database.connected !== true) {
    throw new Error(`launcher database is not connected: ${JSON.stringify(health.database ?? null)}`);
  }
  if (!json) {
    console.log(`[manager-dispatch-smoke] launcher healthy; database=${health.database.status}`);
  }
}

async function managerStatus(launcherUrl, workspaceId, agentId) {
  const url = new URL("/api/runtime/manager-status", launcherUrl);
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("agent_id", agentId);
  return fetchJson(url.href);
}

async function createWorkItem(client, fixture, opts) {
  const now = new Date();
  const id = randomUUID();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const title = renderTemplate(fixture.title || "Manager dispatch smoke {{timestamp}}", {
    timestamp,
  });

  const payload = {
    id,
    workspace_id: opts.workspaceId,
    manager_runner_id: opts.agentId,
    identifier: fixture.identifier || `MGR-SMOKE-${timestamp}`,
    title,
    description: fixture.description || null,
    state: fixture.state || "running",
    priority: fixture.priority || "medium",
    source: fixture.source || "planner",
    labels: Array.isArray(fixture.labels) ? fixture.labels : ["runtime-smoke"],
    metadata: {
      ...(isPlainObject(fixture.metadata) ? fixture.metadata : {}),
      manager_dispatch_smoke: {
        id,
        scenario_id: "manager-due-work-item",
        created_at: now.toISOString(),
        expected_tool: fixture.expected?.tool || null,
      },
    },
    next_poll_at: fixture.next_poll_at || new Date(now.getTime() - 1000).toISOString(),
  };

  const rows = await postgrest(client, "POST", "/work_items", {
    query: { select: SELECT_WORK_ITEM },
    prefer: "return=representation",
    body: payload,
  });

  const created = Array.isArray(rows) ? rows[0] : null;
  if (!created?.id) {
    throw new Error(`work item insert returned no row: ${JSON.stringify(rows)}`);
  }
  return created;
}

async function forceManagerTick(opts) {
  const url = new URL("/api/runtime/manager-tick", opts.launcherUrl);
  url.searchParams.set("workspace_id", opts.workspaceId);
  url.searchParams.set("agent_id", opts.agentId);
  url.searchParams.set("timeout_ms", String(opts.tickTimeoutMs));
  return fetchJson(url.href, { method: "POST" });
}

function failOnManagerError(status) {
  if (!status || typeof status !== "object") {
    throw new Error("manager status response is empty");
  }
  if (status.status !== "running") {
    throw new Error(`manager is not running: status=${status.status}`);
  }
  if (status.last_error) {
    throw new Error(`manager last_error is present: ${JSON.stringify(status.last_error)}`);
  }
}

async function fetchWorkItem(client, id) {
  const rows = await postgrest(client, "GET", "/work_items", {
    query: {
      id: `eq.${id}`,
      select: SELECT_WORK_ITEM,
      limit: "1",
    },
  });
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`expected one work_items row for ${id}, got ${JSON.stringify(rows)}`);
  }
  return rows[0];
}

async function fetchRunMessages(client, runId, opts) {
  return postgrest(client, "GET", "/message", {
    query: {
      run_id: `eq.${runId}`,
      workspace_id: `eq.${opts.workspaceId}`,
      agent_id: `eq.${opts.agentId}`,
      select: "id,role,created_at,run_id,metadata",
      order: "created_at.desc",
      limit: "10",
    },
  });
}

function assertDispatchEvidence({ fixture, created, finalWorkItem, tick, messages, beforeStatus }) {
  const tickAt = Date.parse(tick.last_tick_at);
  const beforeTickAt = beforeStatus.last_tick_at ? Date.parse(beforeStatus.last_tick_at) : 0;
  if (!Number.isFinite(tickAt) || tickAt <= beforeTickAt) {
    throw new Error(`manager did not report a fresh tick: ${tick.last_tick_at}`);
  }
  if ((tick.batch?.total || 0) < 1 || (tick.batch?.ok || 0) < 1) {
    throw new Error(`manager tick did not process a due item: ${JSON.stringify(tick.batch ?? null)}`);
  }

  const expectedTool = fixture.expected?.tool;
  const toolCalls = messages.flatMap((message) => message.metadata?.tool_calls || []);
  const chosenAction = firstToolName(toolCalls) || inferActionFromWorkItem(created, finalWorkItem);

  if (!chosenAction) {
    throw new Error("manager tick completed but no tool action or database action was detected");
  }

  if (
    expectedTool &&
    chosenAction !== expectedTool &&
    !toolCalls.some((call) => call.tool === expectedTool && call.status === "ok")
  ) {
    throw new Error(`expected successful tool call ${expectedTool}, got ${JSON.stringify(toolCalls)}`);
  }

  const expectedState = fixture.expected?.state;
  if (expectedState && finalWorkItem.state !== expectedState) {
    throw new Error(`expected work item state ${expectedState}, got ${finalWorkItem.state}`);
  }

  return {
    passed: true,
    chosen_action: chosenAction,
    expected_tool: expectedTool || null,
    expected_state: expectedState || null,
    tool_calls: toolCalls,
    database: {
      work_item_id: finalWorkItem.id,
      state: finalWorkItem.state,
      next_poll_at: finalWorkItem.next_poll_at,
      updated_at: finalWorkItem.updated_at,
    },
  };
}

function firstToolName(toolCalls) {
  const call = toolCalls.find((item) => item.status === "ok" && item.tool);
  return call?.tool || null;
}

function inferActionFromWorkItem(created, finalWorkItem) {
  if (finalWorkItem.state === "done" && created.state !== "done") return "mark_done";
  if (finalWorkItem.next_poll_at && finalWorkItem.next_poll_at !== created.next_poll_at) return "snooze";
  return null;
}

function firstRunId(tick) {
  const result = tick?.batch?.results?.[0];
  return result?.run_id || null;
}

function summaryPayload({ opts, fixture, created, finalWorkItem, beforeStatus, tick, messages, assertion }) {
  const runId = firstRunId(tick);
  return {
    scenarioId: "manager-due-work-item",
    status: "passed",
    workspaceId: opts.workspaceId,
    agentId: opts.agentId,
    workItemId: created.id,
    runId,
    startedAt: created.metadata?.manager_dispatch_smoke?.created_at || null,
    finishedAt: new Date().toISOString(),
    manager: {
      provider: tick.provider,
      model: tick.model,
      previous_tick_at: beforeStatus.last_tick_at || null,
      last_tick_at: tick.last_tick_at,
      last_decision_count: tick.last_decision_count,
    },
    chosenAction: assertion.chosen_action,
    databaseAssertion: assertion.database,
    expected: fixture.expected || {},
    messageIds: messages.map((message) => message.id),
    nextCommands: [
      `pnpm run logs:runtime -- --since 10m --agent-id ${opts.agentId}`,
      `pnpm run smoke:manager -- --workspace-id ${opts.workspaceId}`,
    ],
    finalWorkItem,
  };
}

function printSummary(summary, json) {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("[manager-dispatch-smoke] passed");
  console.log(JSON.stringify(summary, null, 2));
}

async function deleteWorkItem(client, id) {
  await postgrest(client, "DELETE", "/work_items", {
    query: { id: `eq.${id}` },
    prefer: "return=minimal",
  });
}

async function postgrest(client, method, pathname, { query = {}, body, prefer } = {}) {
  const url = new URL(`${client.endpoint}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    accept: "application/json",
    apikey: client.apiKey,
    authorization: `Bearer ${client.apiKey}`,
  };
  if (prefer) headers.prefer = prefer;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(url.href, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${redactUrl(url.href)} failed with ${response.status}: ${text}`);
  }
  return parsed;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...(init.headers || {}) },
    ...init,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${url} failed with ${response.status}: ${text}`);
  }
  return body;
}

function renderTemplate(value, vars) {
  return String(value).replace(/\{\{\s*timestamp\s*\}\}/g, vars.timestamp);
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function redactUrl(value) {
  const url = new URL(value);
  for (const key of ["apikey", "Authorization", "authorization"]) {
    if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]");
  }
  return url.href;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnv(rawValue.trim());
  }
}

function unquoteEnv(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

main().catch((error) => {
  console.error(`[manager-dispatch-smoke] failed: ${error.message}`);
  process.exit(1);
});
