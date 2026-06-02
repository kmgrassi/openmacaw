#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { TranscriptRecorder, summarizeGatewayFrame, summarizeGatewayRequest } from "./agent-transcript.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";
const DEFAULT_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_USER_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_TIMEOUT_MS = 15_000;
const REQUIRED_METHODS = ["sessions.list", "models.list", "config.get"];

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensureWebSocketRuntime();

  const smoke = new GatewaySmoke(opts);
  const result = await smoke.run();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  process.exit(result.ok ? 0 : 1);
}

class GatewaySmoke {
  constructor(opts) {
    this.opts = opts;
    this.socket = null;
    this.frames = [];
    this.waiters = [];
    this.recorder = new TranscriptRecorder(opts.recordPath, {
      command: "gateway-smoke",
      base_url: opts.baseUrl,
      agent_id: opts.agentId,
      workspace_id: opts.workspaceId,
      user_id: opts.userId,
      message_present: Boolean(opts.message),
      message_length: opts.message ? opts.message.length : 0,
    });
    this.result = {
      ok: false,
      base_url: opts.baseUrl,
      websocket_url: buildWsUrl(opts),
      scope: {
        agent_id: opts.agentId,
        workspace_id: opts.workspaceId,
        user_id: opts.userId,
      },
      session_key: opts.sessionKey,
      checks: [],
      request_ids: {},
      run_id: null,
      next_steps: [],
      transcript_path: opts.recordPath || null,
    };
  }

  async run() {
    try {
      await this.connectSocket();
      await this.connectGateway();

      for (const method of REQUIRED_METHODS) {
        await this.requestCheck(method, paramsForMethod(method, this.opts));
      }

      if (this.opts.message) {
        await this.chatCheck();
      }

      this.result.ok = this.result.checks.every((check) => check.status === "passed");
    } catch (error) {
      this.result.next_steps = nextStepsFor(error);
      if (!this.result.checks.some((check) => check.status === "failed")) {
        this.addCheck("gateway", "failed", { error: error.message });
      }
      this.result.ok = false;
    } finally {
      this.recorder.close({ ok: this.result.ok, checks: this.result.checks, run_id: this.result.run_id });
      this.closeSocket();
    }

    return this.result;
  }

  async connectSocket() {
    const wsUrl = this.result.websocket_url;
    this.socket = new WebSocket(wsUrl);

    this.socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      let frame = null;

      try {
        frame = JSON.parse(text);
      } catch {
        frame = { type: "unparseable", raw_length: text.length };
      }

      this.recorder.record("gateway.frame.received", summarizeGatewayFrame(frame));
      this.enqueueFrame(frame);
    });

    this.socket.addEventListener("close", (event) => {
      const frame = { type: "socket.close", code: event.code, reason: event.reason || "" };
      this.recorder.record("gateway.socket.close", summarizeGatewayFrame(frame));
      this.enqueueFrame(frame);
    });

    this.socket.addEventListener("error", () => {
      const frame = { type: "socket.error", message: "websocket error" };
      this.recorder.record("gateway.socket.error", summarizeGatewayFrame(frame));
      this.enqueueFrame(frame);
    });

    await waitForSocketOpen(this.socket, this.opts.timeoutMs);
    this.addCheck("websocket.connect", "passed");
  }

  async connectGateway() {
    const requestId = randomUUID();
    this.result.request_ids.connect = requestId;
    this.sendRequest(requestId, "connect", {});

    const frame = await this.waitForFrame(
      (candidate) => candidate.type === "hello-ok" || responseMatches(candidate, requestId),
      this.opts.timeoutMs,
    );

    if (frame.type === "hello-ok") {
      this.addCheck("gateway.hello-ok", "passed", {
        request_id: requestId,
        protocol: frame.protocol ?? null,
        conn_id: frame.server?.connId ?? null,
        methods: frame.features?.methods ?? [],
      });
      return;
    }

    throw new SmokeError("gateway.hello-ok", responseError(frame) || "connect did not return hello-ok");
  }

  async requestCheck(method, params) {
    const requestId = randomUUID();
    this.result.request_ids[method] = requestId;
    this.sendRequest(requestId, method, params);

    const frame = await this.waitForFrame((candidate) => responseMatches(candidate, requestId), this.opts.timeoutMs);

    if (frame.ok === true) {
      this.addCheck(method, "passed", {
        request_id: requestId,
        summary: responseSummary(method, frame.payload),
      });
      return frame.payload;
    }

    throw new SmokeError(method, responseError(frame) || `${method} failed`);
  }

  async chatCheck() {
    const requestId = randomUUID();
    const idempotencyKey = randomUUID();
    this.result.request_ids["chat.send"] = requestId;

    this.sendRequest(requestId, "chat.send", {
      agent_id: this.opts.agentId,
      workspace_id: this.opts.workspaceId,
      sessionKey: this.opts.sessionKey,
      message: this.opts.message,
      deliver: false,
      idempotencyKey,
    });

    const response = await this.waitForFrame((candidate) => responseMatches(candidate, requestId), this.opts.timeoutMs);

    if (response.ok !== true) {
      throw new SmokeError("chat.send", responseError(response) || "chat.send failed before run started");
    }

    this.result.run_id = response.payload?.runId ?? idempotencyKey;

    try {
      const event = await this.waitForFrame(
        (candidate) =>
          candidate.type === "event" &&
          candidate.event === "chat" &&
          ["final", "error", "aborted"].includes(candidate.payload?.state),
        this.opts.timeoutMs,
      );

      const state = event.payload?.state || "unknown";
      this.addCheck("chat.send", "passed", {
        request_id: requestId,
        run_id: this.result.run_id,
        state,
        error_code: event.payload?.errorCode ?? null,
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.addCheck("chat.send", "failed", {
          request_id: requestId,
          run_id: this.result.run_id,
          state: "timeout",
          error: error.message,
        });
        throw new SmokeError("chat.send", "chat.send did not emit a terminal chat event before timeout");
      }

      throw error;
    }
  }

  sendRequest(id, method, params) {
    const request = {
      type: "req",
      id,
      method,
      params,
    };

    this.recorder.record("gateway.request.sent", summarizeGatewayRequest(request));
    this.socket.send(JSON.stringify(request));
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
        },
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

class SmokeError extends Error {
  constructor(check, message) {
    super(message);
    this.check = check;
  }
}

class TimeoutError extends Error {}

function ensureWebSocketRuntime() {
  if (typeof WebSocket !== "undefined") {
    return;
  }

  if (process.execArgv.includes("--experimental-websocket")) {
    throw new Error("Global WebSocket is not available even with --experimental-websocket.");
  }

  const result = spawnSync(process.execPath, ["--experimental-websocket", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.RUNTIME_BASE_URL || process.env.ORCHESTRATOR_URL || DEFAULT_BASE_URL,
    agentId: process.env.RUNTIME_AGENT_ID || DEFAULT_AGENT_ID,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || DEFAULT_WORKSPACE_ID,
    userId: process.env.RUNTIME_USER_ID || DEFAULT_USER_ID,
    sessionKey: process.env.RUNTIME_SESSION_KEY || "",
    message: process.env.RUNTIME_GATEWAY_SMOKE_MESSAGE || process.env.RUNTIME_WS_MESSAGE || "",
    timeoutMs: numberFromEnv("RUNTIME_GATEWAY_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    limit: numberFromEnv("RUNTIME_GATEWAY_SMOKE_LIMIT", 20),
    json: false,
    recordPath: process.env.RUNTIME_AGENT_TRANSCRIPT || "",
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
    } else if (arg === "--message" && next) {
      opts.message = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = parsePositiveInt(next, "--timeout-ms");
      index += 1;
    } else if (arg === "--limit" && next) {
      opts.limit = parsePositiveInt(next, "--limit");
      index += 1;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--record" && next) {
      opts.recordPath = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  opts.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  opts.sessionKey = opts.sessionKey || `${opts.userId}:${opts.workspaceId}:${opts.agentId}`;
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
  console.log(`Usage: pnpm run smoke:gateway -- [options]

Options:
  --base-url <url>          Orchestrator base URL. Default: ${DEFAULT_BASE_URL}
  --agent-id <uuid>         Gateway agent id.
  --workspace-id <uuid>     Gateway workspace id.
  --user-id <uuid>          Gateway user id.
  --session-key <key>       Session key. Default: <user-id>:<workspace-id>:<agent-id>
  --message <text>          Also run chat.send with this message.
  --timeout-ms <ms>         Per-check timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --limit <count>           sessions.list limit. Default: 20
  --json                    Print machine-readable JSON only.
  --record <path>           Write a redacted JSONL transcript.

Environment:
  RUNTIME_BASE_URL, ORCHESTRATOR_URL, RUNTIME_AGENT_ID, RUNTIME_WORKSPACE_ID,
  RUNTIME_USER_ID, RUNTIME_SESSION_KEY, RUNTIME_GATEWAY_SMOKE_MESSAGE,
  RUNTIME_WS_MESSAGE, RUNTIME_GATEWAY_SMOKE_TIMEOUT_MS, RUNTIME_GATEWAY_SMOKE_LIMIT,
  RUNTIME_AGENT_TRANSCRIPT`);
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

function paramsForMethod(method, opts) {
  switch (method) {
    case "sessions.list":
      return { limit: opts.limit };
    case "models.list":
    case "config.get":
      return {};
    default:
      throw new Error(`Unsupported smoke method: ${method}`);
  }
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

function responseSummary(method, payload) {
  if (method === "sessions.list") {
    return { count: payload?.count ?? null };
  }

  if (method === "models.list") {
    return { count: Array.isArray(payload?.models) ? payload.models.length : null };
  }

  if (method === "config.get") {
    return {
      source: payload?.source ?? null,
      hash: payload?.hash ?? null,
    };
  }

  return {};
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

function nextStepsFor(error) {
  if (error instanceof SmokeError && error.check === "chat.send") {
    return [
      "Inspect gateway and runner logs for the emitted run_id/request_id.",
      "Run pnpm run debug:orchestrator:ws -- --message \"health check\" for raw frames.",
    ];
  }

  if (error instanceof TimeoutError) {
    return ["Confirm the orchestrator is running with pnpm run smoke:runtime.", "Tail .run-logs/orchestrator.log."];
  }

  return ["Confirm the orchestrator is running with pnpm run smoke:runtime.", "Run pnpm run debug:orchestrator:ws for raw frames."];
}

function printSummary(result) {
  const status = result.ok ? "passed" : "failed";
  console.log(`[gateway-smoke] ${status}`);
  console.log(`[gateway-smoke] websocket=${result.websocket_url}`);
  console.log(`[gateway-smoke] session_key=${result.session_key}`);
  if (result.transcript_path) console.log(`[gateway-smoke] transcript=${result.transcript_path}`);

  for (const check of result.checks) {
    const details = [];
    if (check.request_id) details.push(`request_id=${check.request_id}`);
    if (check.run_id) details.push(`run_id=${check.run_id}`);
    if (check.state) details.push(`state=${check.state}`);
    if (check.error_code) details.push(`error_code=${check.error_code}`);
    if (check.error) details.push(`error=${check.error}`);

    console.log(`[gateway-smoke] ${check.status} ${check.name}${details.length ? ` (${details.join(" ")})` : ""}`);
  }

  if (result.next_steps.length > 0) {
    console.log("[gateway-smoke] next steps:");
    for (const step of result.next_steps) {
      console.log(`- ${step}`);
    }
  }
}

main().catch((error) => {
  console.error(`[gateway-smoke] failed: ${error.message}`);
  process.exit(1);
});
