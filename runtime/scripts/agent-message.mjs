#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";
const DEFAULT_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_USER_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_TIMEOUT_MS = 60_000;
const TERMINAL_STATES = new Set(["final", "error", "aborted"]);

async function main() {
  ensureWebSocketRuntime();

  const opts = parseArgs(process.argv.slice(2));
  const command = new AgentMessageCommand(opts);
  const result = await command.run();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  process.exit(result.ok ? 0 : 1);
}

class AgentMessageCommand {
  constructor(opts) {
    this.opts = opts;
    this.socket = null;
    this.frames = [];
    this.waiters = [];
    this.result = {
      ok: false,
      base_url: opts.baseUrl,
      websocket_url: buildWsUrl(opts),
      workspace_id: opts.workspaceId,
      agent_id: opts.agentId,
      user_id: opts.userId,
      session_key: opts.sessionKey,
      request_id: null,
      input_request_id: opts.inputRequestId,
      run_id: null,
      final_state: null,
      error_code: null,
      error_message: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      events: [],
      next_commands: [],
    };
  }

  async run() {
    try {
      await this.connectSocket();
      await this.connectGateway();
      await this.sendMessage();
      this.result.ok = this.result.final_state === "final";
    } catch (error) {
      this.result.error_message = this.result.error_message || error.message;
      this.result.next_commands = diagnosticCommands(this.result);
      this.result.ok = false;
    } finally {
      this.result.finished_at = new Date().toISOString();
      if (this.result.next_commands.length === 0) {
        this.result.next_commands = diagnosticCommands(this.result);
      }
      this.closeSocket();
    }

    return this.result;
  }

  async connectSocket() {
    this.socket = new WebSocket(this.result.websocket_url);

    this.socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      let frame;

      try {
        frame = JSON.parse(text);
      } catch {
        frame = { type: "unparseable", raw_length: text.length };
      }

      this.enqueueFrame(frame);
    });

    this.socket.addEventListener("close", (event) => {
      this.enqueueFrame({ type: "socket.close", code: event.code, reason: event.reason || "" });
    });

    this.socket.addEventListener("error", () => {
      this.enqueueFrame({ type: "socket.error", message: "websocket error" });
    });

    await waitForSocketOpen(this.socket, this.opts.timeoutMs);
    this.result.events.push({ type: "websocket.connected" });
  }

  async connectGateway() {
    const requestId = randomUUID();
    this.sendRequest(requestId, "connect", {});

    const frame = await this.waitForFrame(
      (candidate) => candidate.type === "hello-ok" || responseMatches(candidate, requestId),
      this.opts.timeoutMs,
    );

    if (frame.type === "hello-ok") {
      this.result.events.push({
        type: "gateway.connected",
        request_id: requestId,
        protocol: frame.protocol ?? null,
        conn_id: frame.server?.connId ?? null,
      });
      return;
    }

    throw new Error(responseError(frame) || "connect did not return hello-ok");
  }

  async sendMessage() {
    const requestId = randomUUID();
    const idempotencyKey = this.opts.runId || randomUUID();
    this.result.request_id = requestId;

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
      throw new Error(responseError(response) || "chat.send failed before run started");
    }

    this.result.run_id = response.payload?.runId ?? idempotencyKey;
    this.result.events.push({
      type: "chat.accepted",
      request_id: requestId,
      run_id: this.result.run_id,
    });

    const event = await this.waitForFrame(
      (candidate) =>
        candidate.type === "event" &&
        candidate.event === "chat" &&
        candidate.payload?.runId === this.result.run_id &&
        TERMINAL_STATES.has(candidate.payload?.state),
      this.opts.timeoutMs,
    );

    this.result.final_state = event.payload?.state || "unknown";
    this.result.error_code = event.payload?.errorCode ?? null;
    this.result.error_message = event.payload?.errorMessage ?? this.result.error_message;
    this.result.events.push({
      type: "chat.terminal",
      run_id: this.result.run_id,
      state: this.result.final_state,
      error_code: this.result.error_code,
    });

    if (this.result.final_state !== "final") {
      throw new Error(`chat.send reached terminal state ${this.result.final_state}`);
    }
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
        reject(new Error(`timed out after ${timeoutMs}ms waiting for websocket frame`));
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

  closeSocket() {
    if (!this.socket) return;

    try {
      this.socket.close();
    } catch {
      // no-op
    }
  }
}

function parseArgs(argv) {
  let input = {};
  const explicit = new Set();
  const opts = {
    baseUrl: process.env.RUNTIME_BASE_URL || process.env.ORCHESTRATOR_URL || DEFAULT_BASE_URL,
    agentId: process.env.RUNTIME_AGENT_ID || DEFAULT_AGENT_ID,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || DEFAULT_WORKSPACE_ID,
    userId: process.env.RUNTIME_USER_ID || DEFAULT_USER_ID,
    sessionKey: process.env.RUNTIME_SESSION_KEY || "",
    message: process.env.RUNTIME_AGENT_MESSAGE || process.env.RUNTIME_WS_MESSAGE || "",
    timeoutMs: numberFromEnv("RUNTIME_AGENT_MESSAGE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    json: false,
    runId: "",
    inputRequestId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--input" && next) {
      input = { ...input, ...readJsonInput(next) };
      index += 1;
    } else if (arg === "--base-url" && next) {
      opts.baseUrl = next;
      explicit.add("baseUrl");
      index += 1;
    } else if (arg === "--agent-id" && next) {
      opts.agentId = next;
      explicit.add("agentId");
      index += 1;
    } else if (arg === "--workspace-id" && next) {
      opts.workspaceId = next;
      explicit.add("workspaceId");
      index += 1;
    } else if (arg === "--user-id" && next) {
      opts.userId = next;
      explicit.add("userId");
      index += 1;
    } else if (arg === "--session-key" && next) {
      opts.sessionKey = next;
      explicit.add("sessionKey");
      index += 1;
    } else if (arg === "--message" && next) {
      opts.message = next;
      explicit.add("message");
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = parsePositiveInt(next, "--timeout-ms");
      index += 1;
    } else if (arg === "--run-id" && next) {
      opts.runId = next;
      explicit.add("runId");
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

  applyInput(opts, input, explicit);

  opts.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  opts.sessionKey = opts.sessionKey || `${opts.userId}:${opts.workspaceId}:${opts.agentId}`;

  if (!opts.message) {
    throw new Error("Missing required --message <text>");
  }

  return opts;
}

function applyInput(opts, input, explicit) {
  const agentId = firstString(input, ["agent_id", "agentId"]);
  const workspaceId = firstString(input, ["workspace_id", "workspaceId"]);
  const userId = firstString(input, ["user_id", "userId"]);
  const sessionKey = firstString(input, ["session_key", "sessionKey"]);
  const requestId = firstString(input, ["request_id", "requestId"]);
  const runId = firstString(input, ["run_id", "runId"]);
  const baseUrl = firstString(input, ["base_url", "baseUrl", "runtimeBaseUrl"]);
  const message = firstString(input, ["message", "prompt"]);

  opts.agentId = !explicit.has("agentId") && agentId ? agentId : opts.agentId;
  opts.workspaceId = !explicit.has("workspaceId") && workspaceId ? workspaceId : opts.workspaceId;
  opts.userId = !explicit.has("userId") && userId ? userId : opts.userId;
  opts.sessionKey = !explicit.has("sessionKey") && sessionKey ? sessionKey : opts.sessionKey;
  opts.inputRequestId = requestId || opts.inputRequestId;
  opts.runId = !explicit.has("runId") && runId ? runId : opts.runId;
  opts.baseUrl = !explicit.has("baseUrl") && baseUrl ? baseUrl : opts.baseUrl;
  opts.message = !explicit.has("message") && message ? message : opts.message;
}

function firstString(root, names) {
  const found = findString(root, new Set(names), new WeakSet());
  return found || "";
}

function findString(value, names, seen) {
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) && typeof child === "string" && child.length > 0) {
      return child;
    }
  }

  for (const child of Object.values(value)) {
    const found = findString(child, names, seen);
    if (found) return found;
  }

  return "";
}

function readJsonInput(path) {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse JSON input ${path}: ${error.message}`);
  }
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
      reject(new Error(`timed out after ${timeoutMs}ms waiting for websocket open`));
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

function diagnosticCommands(result) {
  const commands = ["pnpm run smoke:runtime", "pnpm run logs:runtime -- --since 10m"];

  if (result.run_id) {
    commands.push(`pnpm run logs:runtime -- --since 10m --run-id ${result.run_id}`);
  }

  if (result.agent_id && result.workspace_id) {
    commands.push(
      `pnpm run debug:orchestrator:ws -- --agent-id ${result.agent_id} --workspace-id ${result.workspace_id} --message "health check"`,
    );
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

function printUsage() {
  console.log(`Usage: pnpm run agent:message -- [options]

Options:
  --base-url <url>          Orchestrator base URL. Default: ${DEFAULT_BASE_URL}
  --agent-id <uuid>         Gateway agent id.
  --workspace-id <uuid>     Gateway workspace id.
  --user-id <uuid>          Gateway user id.
  --session-key <key>       Session key. Default: <user-id>:<workspace-id>:<agent-id>
  --message <text>          Message to send through chat.send.
  --input <file|->          JSON output from platform agent:send-message or doctor.
  --run-id <id>             Optional idempotency key/run id for correlation.
  --timeout-ms <ms>         WebSocket wait timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --json                    Print machine-readable JSON only.

Environment:
  RUNTIME_BASE_URL, ORCHESTRATOR_URL, RUNTIME_AGENT_ID, RUNTIME_WORKSPACE_ID,
  RUNTIME_USER_ID, RUNTIME_SESSION_KEY, RUNTIME_AGENT_MESSAGE,
  RUNTIME_WS_MESSAGE, RUNTIME_AGENT_MESSAGE_TIMEOUT_MS`);
}

function printSummary(result) {
  const status = result.ok ? "passed" : "failed";
  console.log(`[agent-message] ${status}`);
  console.log(`[agent-message] websocket=${result.websocket_url}`);
  console.log(`[agent-message] workspace_id=${result.workspace_id}`);
  console.log(`[agent-message] agent_id=${result.agent_id}`);
  console.log(`[agent-message] session_key=${result.session_key}`);

  if (result.request_id) console.log(`[agent-message] request_id=${result.request_id}`);
  if (result.run_id) console.log(`[agent-message] run_id=${result.run_id}`);
  if (result.final_state) console.log(`[agent-message] final_state=${result.final_state}`);
  if (result.error_code) console.log(`[agent-message] error_code=${result.error_code}`);
  if (result.error_message) console.log(`[agent-message] error=${result.error_message}`);

  if (result.next_commands.length > 0) {
    console.log("[agent-message] next commands:");
    for (const command of result.next_commands) {
      console.log(`- ${command}`);
    }
  }
}

main().catch((error) => {
  console.error(`[agent-message] failed: ${error.message}`);
  process.exit(1);
});
