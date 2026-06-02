#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";
const DEFAULT_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_USER_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_TIMEOUT_MS = 45_000;
const TOOL_STATES = new Set(["tool_call_started", "tool_call_completed", "tool_call_failed"]);
const SECRET_KEY_PATTERN = /(authorization|api[_-]?key|secret|token|password|service[_-]?role|bearer)/i;

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  ensureWebSocketRuntime();

  const fixture = await loadFixture(opts.fixturePath);
  if (!argv.includes("--timeout-ms") && !process.env.RUNTIME_AGENT_TOOL_TIMEOUT_MS && fixture.timeout_ms) {
    opts.timeoutMs = parsePositiveInt(String(fixture.timeout_ms), "fixture.timeout_ms");
  }

  const smoke = new AgentToolSmoke({ ...opts, fixture });
  const result = await smoke.run();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  return result.ok ? 0 : 1;
}

class AgentToolSmoke {
  constructor(opts) {
    this.opts = opts;
    this.socket = null;
    this.frames = [];
    this.waiters = [];
    this.rawTimeline = [];
    this.result = {
      ok: false,
      scenario_id: opts.fixture.scenario_id ?? null,
      base_url: opts.baseUrl,
      websocket_url: buildWsUrl(opts),
      workspace_id: opts.workspaceId,
      agent_id: opts.agentId,
      session_key: opts.sessionKey,
      request_id: null,
      run_id: null,
      tool_name: expectedToolName(opts),
      platform_tool_slug: expectedPlatformToolSlug(opts),
      timeline: [],
      checks: [],
      database_assertion: null,
      next_commands: []
    };
  }

  async run() {
    try {
      await this.connectSocket();
      await this.connectGateway();
      await this.sendMessage();
      this.assertTimeline();
      await this.runDatabaseAssertion();
      this.result.ok = this.result.checks.every((check) => check.status === "passed" || check.status === "skipped");
    } catch (error) {
      this.addCheck(error.check || "agent.tool-smoke", "failed", { error: error.message });
      this.result.next_commands = nextCommands(this.result);
      this.result.ok = false;
    } finally {
      this.closeSocket();
    }

    return this.result;
  }

  async connectSocket() {
    this.socket = new WebSocket(this.result.websocket_url);

    this.socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      try {
        this.enqueueFrame(JSON.parse(text));
      } catch {
        this.enqueueFrame({ type: "unparseable", raw_length: text.length });
      }
    });

    this.socket.addEventListener("close", (event) => {
      this.enqueueFrame({ type: "socket.close", code: event.code, reason: event.reason || "" });
    });

    this.socket.addEventListener("error", () => {
      this.enqueueFrame({ type: "socket.error", message: "websocket error" });
    });

    await waitForSocketOpen(this.socket, this.opts.timeoutMs);
    this.addCheck("websocket.connect", "passed");
  }

  async connectGateway() {
    const requestId = randomUUID();
    this.sendRequest(requestId, "connect", {});
    const frame = await this.waitForFrame(
      (candidate) => candidate.type === "hello-ok" || responseMatches(candidate, requestId),
      this.opts.timeoutMs
    );

    if (frame.type === "hello-ok") {
      this.addCheck("gateway.hello-ok", "passed", { request_id: requestId });
      return;
    }

    throw new SmokeError("gateway.hello-ok", responseError(frame) || "connect did not return hello-ok");
  }

  async sendMessage() {
    const requestId = randomUUID();
    const idempotencyKey = randomUUID();
    this.result.request_id = requestId;

    this.sendRequest(requestId, "chat.send", {
      agent_id: this.opts.agentId,
      workspace_id: this.opts.workspaceId,
      sessionKey: this.opts.sessionKey,
      message: this.opts.fixture.prompt,
      deliver: false,
      idempotencyKey
    });

    const response = await this.waitForFrame((candidate) => responseMatches(candidate, requestId), this.opts.timeoutMs);

    if (response.ok !== true) {
      throw new SmokeError("message", responseError(response) || "chat.send failed before run started");
    }

    this.result.run_id = response.payload?.runId ?? idempotencyKey;
    this.pushTimeline("message", {
      request_id: requestId,
      run_id: this.result.run_id
    });

    await this.collectUntilTerminal();
  }

  async collectUntilTerminal() {
    const deadline = Date.now() + this.opts.timeoutMs;

    while (Date.now() < deadline) {
      const frame = await this.waitForFrame(
        (candidate) => candidate.type === "event" && candidate.event === "chat",
        Math.max(deadline - Date.now(), 1)
      );

      const state = frame.payload?.state;

      if (TOOL_STATES.has(state)) {
        this.recordToolEvent(state, frame.payload || {});
        continue;
      }

      if (state === "final" || state === "error" || state === "aborted") {
        this.pushTimeline(state, {
          run_id: frame.payload?.runId ?? this.result.run_id,
          error_code: frame.payload?.errorCode ?? null,
          error_message: redactValue(frame.payload?.errorMessage ?? null)
        });

        if (state !== "final") {
          throw new SmokeError("final", `chat run ended with ${state}`);
        }

        return;
      }
    }

    throw new SmokeError("final", `timed out after ${this.opts.timeoutMs}ms waiting for a terminal chat event`);
  }

  recordToolEvent(state, payload) {
    const entry = normalizeToolEvent(state, payload);

    this.rawTimeline.push(entry);
    this.pushTimeline(state, {
      tool_call_id: entry.tool_call_id,
      tool_name: entry.tool_name,
      platform_tool_slug: entry.platform_tool_slug,
      success: entry.success,
      duration_ms: entry.duration_ms,
      arguments: redactValue(entry.arguments),
      result: redactValue(entry.result)
    });
  }

  assertTimeline() {
    const expectedTool = expectedToolName(this.opts);
    const started = this.rawTimeline.find((event) => event.state === "tool_call_started" && event.tool_name === expectedTool);
    const completed = this.rawTimeline.find((event) => event.state === "tool_call_completed" && event.tool_name === expectedTool);
    const failed = this.rawTimeline.find((event) => event.state === "tool_call_failed" && event.tool_name === expectedTool);
    const observed = started || completed || failed;
    const final = this.result.timeline.find((event) => event.state === "final");

    if (!observed) {
      throw new SmokeError("tool.name", `agent did not emit a ${expectedTool} tool event`);
    }

    this.addCheck("tool.name", "passed", {
      expected: expectedTool,
      actual: observed.tool_name,
      platform_tool_slug: expectedPlatformToolSlug(this.opts)
    });

    if (Object.keys(fixtureArgumentSubset(this.opts.fixture)).length > 0 && !plainObject(observed.arguments)) {
      this.addCheck("tool.arguments", "skipped", {
        reason: "matching tool event did not include arguments"
      });
    } else {
      assertSubset(
        fixtureArgumentSubset(this.opts.fixture),
        observed.arguments || {},
        "tool arguments"
      );
      this.addCheck("tool.arguments", "passed");
    }

    if (failed && !completed) {
      throw new SmokeError("tool_call_completed", `tool ${expectedTool} failed before completion`);
    }

    if (!completed) {
      throw new SmokeError("tool_call_completed", "tool call started but did not complete");
    }

    assertSubset(
      fixtureResultSubset(this.opts.fixture),
      completed.assertion_payload || {},
      "tool result"
    );
    this.addCheck("tool.result", "passed", { tool_call_id: completed.tool_call_id });

    if (!final) {
      throw new SmokeError("final", "assistant did not finish after the tool result");
    }

    this.addCheck("timeline", "passed", {
      states: this.result.timeline.map((event) => event.state)
    });
  }

  async runDatabaseAssertion() {
    const assertion = this.opts.fixture.database_assertion;

    if (!assertion) {
      return;
    }

    this.result.database_assertion = await runSupabaseAssertion(assertion);
    this.addCheck("database.assertion", "passed", {
      table: assertion.table,
      rows: this.result.database_assertion.row_count
    });
  }

  sendRequest(id, method, params) {
    this.socket.send(JSON.stringify({ type: "req", id, method, params }));
  }

  waitForFrame(predicate, timeoutMs) {
    const existingIndex = this.frames.findIndex(predicate);
    if (existingIndex >= 0) {
      const [frame] = this.frames.splice(existingIndex, 1);
      return Promise.resolve(frame);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== waiterRecord);
        reject(new TimeoutError(`timed out after ${timeoutMs}ms waiting for websocket frame`));
      }, timeoutMs);

      const waiterRecord = {
        predicate,
        resolve: (frame) => {
          clearTimeout(timeout);
          resolve(frame);
        }
      };

      this.waiters.push(waiterRecord);
    });
  }

  enqueueFrame(frame) {
    const waiter = this.waiters.find((candidate) => candidate.predicate(frame));
    if (waiter) {
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(frame);
      return;
    }

    this.frames.push(frame);
  }

  pushTimeline(state, fields = {}) {
    this.result.timeline.push({ state, ...dropNullValues(fields) });
  }

  addCheck(name, status, extra = {}) {
    const existing = this.result.checks.find((check) => check.name === name);
    const check = { name, status, ...extra };

    if (existing) {
      Object.assign(existing, check);
    } else {
      this.result.checks.push(check);
    }
  }

  closeSocket() {
    if (!this.socket) return;

    try {
      this.socket.close();
    } catch {
      // no-op
    }
  }
}

export function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.RUNTIME_BASE_URL || process.env.ORCHESTRATOR_URL || DEFAULT_BASE_URL,
    agentId: process.env.RUNTIME_AGENT_ID || DEFAULT_AGENT_ID,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || DEFAULT_WORKSPACE_ID,
    userId: process.env.RUNTIME_USER_ID || DEFAULT_USER_ID,
    sessionKey: process.env.RUNTIME_SESSION_KEY || "",
    fixturePath: process.env.RUNTIME_AGENT_TOOL_FIXTURE || "",
    tool: process.env.RUNTIME_AGENT_TOOL || "",
    timeoutMs: numberFromEnv("RUNTIME_AGENT_TOOL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--base-url" && next) {
      opts.baseUrl = next;
      index += 1;
    } else if (arg === "--agent-id" && next) {
      opts.agentId = next;
      index += 1;
    } else if (arg === "--workspace-id" && next) {
      opts.workspaceId = next;
      index += 1;
    } else if (arg === "--user-id" && next) {
      opts.userId = next;
      index += 1;
    } else if (arg === "--session-key" && next) {
      opts.sessionKey = next;
      index += 1;
    } else if (arg === "--tool" && next) {
      opts.tool = next;
      index += 1;
    } else if (arg === "--fixture" && next) {
      opts.fixturePath = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = parsePositiveInt(next, "--timeout-ms");
      index += 1;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!opts.fixturePath) {
    throw new Error("--fixture is required");
  }

  opts.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  opts.sessionKey = opts.sessionKey || `${opts.userId}:${opts.workspaceId}:${opts.agentId}`;
  return opts;
}

export async function loadFixture(path) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  validateFixture(fixture, path);
  return fixture;
}

export function validateFixture(fixture, label = "fixture") {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error(`${label} must be a JSON object`);
  }

  if (typeof fixture.prompt !== "string" || fixture.prompt.trim() === "") {
    throw new Error(`${label} must include non-empty prompt`);
  }

  if (typeof fixture.expected_tool_name !== "string" || fixture.expected_tool_name.trim() === "") {
    throw new Error(`${label} must include non-empty expected_tool_name`);
  }

  for (const key of ["expected_arguments", "expected_argument_subset", "expected_result_subset"]) {
    if (fixture[key] !== undefined && !plainObject(fixture[key])) {
      throw new Error(`${label}.${key} must be an object when present`);
    }
  }

  if (fixture.timeout_ms !== undefined) {
    parsePositiveInt(String(fixture.timeout_ms), `${label}.timeout_ms`);
  }

  return fixture;
}

export function assertSubset(expected, actual, label = "value") {
  if (!expected || Object.keys(expected).length === 0) {
    return;
  }

  const mismatch = findSubsetMismatch(expected, actual);
  if (mismatch) {
    throw new SmokeError(label, `${label} mismatch at ${mismatch.path}: expected ${JSON.stringify(mismatch.expected)}, saw ${JSON.stringify(mismatch.actual)}`);
  }
}

export function redactValue(value, key = "") {
  if (value === null || value === undefined) {
    return value;
  }

  if (SECRET_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key));
  }

  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]));
  }

  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 500)}...[truncated ${value.length - 500} chars]`;
  }

  return value;
}

export function normalizeToolEvent(state, payload) {
  const params = plainObject(payload.params) ? payload.params : {};
  const details = plainObject(payload.details) ? payload.details : {};
  const success = payload.success ?? details.success ?? (state === "tool_call_completed" ? true : null);

  return {
    state,
    tool_call_id: payload.tool_call_id ?? payload.toolCallId ?? payload.id ?? params.callId ?? params.toolCallId ?? params.tool_call_id ?? null,
    tool_name: payload.tool_name ?? payload.toolName ?? payload.name ?? params.tool ?? params.name ?? null,
    platform_tool_slug: payload.platform_tool_slug ?? payload.platformToolSlug ?? payload.tool_slug ?? params.platformToolSlug ?? params.toolSlug ?? null,
    success,
    duration_ms: payload.duration_ms ?? payload.durationMs ?? details.duration_ms ?? details.durationMs ?? null,
    arguments: payload.arguments ?? params.arguments ?? details.arguments ?? null,
    result: payload.result ?? payload.output ?? details.output ?? details.result ?? null,
    raw_payload: payload,
    assertion_payload: {
      ...payload,
      params,
      details,
      success
    }
  };
}

async function runSupabaseAssertion(assertion) {
  if (!plainObject(assertion)) {
    throw new SmokeError("database.assertion", "database_assertion must be an object");
  }

  const supabaseUrl = process.env[assertion.url_env || "SUPABASE_URL"];
  const serviceRoleKey = process.env[assertion.service_role_key_env || "SUPABASE_SERVICE_ROLE_KEY"];

  if (!supabaseUrl || !serviceRoleKey) {
    throw new SmokeError("database.assertion", "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for database assertions");
  }

  const url = new URL(`/rest/v1/${assertion.table}`, supabaseUrl);
  url.searchParams.set("select", assertion.select || "*");

  for (const [column, filter] of Object.entries(assertion.filters || {})) {
    if (plainObject(filter)) {
      const [[operator, value]] = Object.entries(filter);
      url.searchParams.set(column, `${operator}.${value}`);
    } else {
      url.searchParams.set(column, `eq.${filter}`);
    }
  }

  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`
    }
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new SmokeError("database.assertion", `Supabase REST assertion failed with HTTP ${response.status}`);
  }

  if (!Array.isArray(body)) {
    throw new SmokeError("database.assertion", "Supabase REST assertion did not return an array");
  }

  if (assertion.expected_empty === true && body.length !== 0) {
    throw new SmokeError("database.assertion", `expected no ${assertion.table} rows, saw ${body.length}`);
  }

  if (assertion.expected_row_subset) {
    const matched = body.some((row) => {
      try {
        assertSubset(assertion.expected_row_subset, row, "database row");
        return true;
      } catch {
        return false;
      }
    });

    if (!matched) {
      throw new SmokeError("database.assertion", `no ${assertion.table} row matched expected_row_subset`);
    }
  }

  return {
    table: assertion.table,
    row_count: body.length,
    rows: redactValue(body)
  };
}

function findSubsetMismatch(expected, actual, path = "$") {
  if (plainObject(expected)) {
    if (!plainObject(actual)) {
      return { path, expected, actual };
    }

    for (const [key, expectedValue] of Object.entries(expected)) {
      const mismatch = findSubsetMismatch(expectedValue, actual[key], `${path}.${key}`);
      if (mismatch) return mismatch;
    }

    return null;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) {
      return { path, expected, actual };
    }

    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = findSubsetMismatch(expected[index], actual[index], `${path}[${index}]`);
      if (mismatch) return mismatch;
    }

    return null;
  }

  if (actual !== expected) {
    return { path, expected, actual };
  }

  return null;
}

function expectedToolName(opts) {
  return opts.tool || opts.fixture.expected_tool_name;
}

function expectedPlatformToolSlug(opts) {
  return opts.fixture.platform_tool_slug || opts.fixture.expected_platform_tool_slug || expectedToolName(opts);
}

function fixtureArgumentSubset(fixture) {
  return fixture.expected_argument_subset || fixture.expected_arguments || {};
}

function fixtureResultSubset(fixture) {
  return fixture.expected_result_subset || {};
}

function ensureWebSocketRuntime() {
  if (typeof WebSocket !== "undefined") {
    return;
  }

  if (process.execArgv.includes("--experimental-websocket")) {
    throw new Error("Global WebSocket is not available even with --experimental-websocket.");
  }

  const result = spawnSync(process.execPath, ["--experimental-websocket", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

function buildWsUrl(options) {
  const url = new URL(options.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("agent_id", options.agentId);
  url.searchParams.set("workspace_id", options.workspaceId);
  url.searchParams.set("user_id", options.userId);
  url.searchParams.set("session_key", options.sessionKey);
  return url.toString();
}

function responseMatches(frame, requestId) {
  return frame.type === "res" && frame.id === requestId;
}

function responseError(frame) {
  const code = frame.error?.code;
  const message = frame.error?.message;
  if (code && message) return `${code}: ${message}`;
  return message || code || null;
}

function waitForSocketOpen(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new TimeoutError(`timed out after ${timeoutMs}ms waiting for websocket open`));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("websocket connection failed"));
    });
  });
}

function nextCommands(result) {
  const commands = ["pnpm run smoke:gateway -- --message \"hello\" --json"];
  if (result.run_id || result.request_id) {
    commands.push("pnpm run logs:runtime -- --since 10m");
  }
  return commands;
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

function dropNullValues(map) {
  return Object.fromEntries(Object.entries(map).filter(([_key, value]) => value !== null && value !== undefined));
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printUsage() {
  console.log(`Usage: pnpm run agent:tool-smoke -- [options]

Options:
  --base-url <url>          Orchestrator base URL. Default: ${DEFAULT_BASE_URL}
  --agent-id <uuid>         Gateway agent id.
  --workspace-id <uuid>     Gateway workspace id.
  --user-id <uuid>          Gateway user id.
  --session-key <key>       Session key. Default: <user-id>:<workspace-id>:<agent-id>
  --tool <name>             Expected runtime tool name. Defaults to fixture expected_tool_name.
  --fixture <path>          Tool-call scenario fixture JSON.
  --timeout-ms <ms>         End-to-end timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --json                    Print machine-readable JSON only.

Environment:
  RUNTIME_BASE_URL, ORCHESTRATOR_URL, RUNTIME_AGENT_ID, RUNTIME_WORKSPACE_ID,
  RUNTIME_USER_ID, RUNTIME_SESSION_KEY, RUNTIME_AGENT_TOOL,
  RUNTIME_AGENT_TOOL_FIXTURE, RUNTIME_AGENT_TOOL_TIMEOUT_MS`);
}

function printSummary(result) {
  console.log(`[agent-tool-smoke] ${result.ok ? "passed" : "failed"}`);
  console.log(`[agent-tool-smoke] run_id=${result.run_id || "none"} request_id=${result.request_id || "none"}`);

  for (const event of result.timeline) {
    const details = [];
    if (event.tool_name) details.push(`tool=${event.tool_name}`);
    if (event.tool_call_id) details.push(`tool_call_id=${event.tool_call_id}`);
    if (event.success !== undefined) details.push(`success=${event.success}`);
    console.log(`[agent-tool-smoke] ${event.state}${details.length ? ` (${details.join(" ")})` : ""}`);
  }

  for (const check of result.checks) {
    const error = check.error ? ` error=${check.error}` : "";
    console.log(`[agent-tool-smoke] ${check.status} ${check.name}${error}`);
  }

  if (result.next_commands.length > 0) {
    console.log("[agent-tool-smoke] next commands:");
    for (const command of result.next_commands) {
      console.log(`- ${command}`);
    }
  }
}

class SmokeError extends Error {
  constructor(check, message) {
    super(message);
    this.check = check;
  }
}

class TimeoutError extends Error {}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error(`[agent-tool-smoke] failed: ${error.message}`);
      process.exit(1);
    });
}
