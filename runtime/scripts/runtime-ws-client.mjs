#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const defaults = {
  baseUrl: process.env.RUNTIME_BASE_URL || "http://127.0.0.1:4000",
  agentId: process.env.RUNTIME_AGENT_ID || "11111111-1111-4111-8111-111111111111",
  workspaceId: process.env.RUNTIME_WORKSPACE_ID || "22222222-2222-4222-8222-222222222222",
  userId: process.env.RUNTIME_USER_ID || "33333333-3333-4333-8333-333333333333",
  sessionKey:
    process.env.RUNTIME_SESSION_KEY ||
    "33333333-3333-4333-8333-333333333333:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111",
  method: process.env.RUNTIME_WS_METHOD || "sessions.list",
  timeoutMs: Number.parseInt(process.env.RUNTIME_WS_TIMEOUT_MS || "15000", 10),
  keepOpen: false,
  message: process.env.RUNTIME_WS_MESSAGE || null,
  limit: Number.parseInt(process.env.RUNTIME_WS_LIMIT || "20", 10)
};

const args = parseArgs(process.argv.slice(2), defaults);

if (typeof WebSocket === "undefined") {
  console.error("Global WebSocket is not available in this Node runtime.");
  console.error("Use a recent Node version that exposes the WHATWG WebSocket client.");
  process.exit(1);
}

const wsUrl = buildWsUrl(args);
const socket = new WebSocket(wsUrl);
const timeout = setTimeout(() => {
  console.error(`[ws] timed out after ${args.timeoutMs}ms`);
  safeClose(socket);
  process.exit(1);
}, args.timeoutMs);

let helloSeen = false;
let requestId = null;
let runId = null;

socket.addEventListener("open", () => {
  console.log(`[ws] connected ${wsUrl}`);
  socket.send(
    JSON.stringify({
      type: "req",
      id: randomUUID(),
      method: "connect",
      params: {}
    })
  );
});

socket.addEventListener("message", (event) => {
  const text = typeof event.data === "string" ? event.data : String(event.data);
  console.log(text);

  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }

  if (frame.type === "hello-ok") {
    helloSeen = true;

    if (args.method === "connect-only") {
      finish(0);
      return;
    }

    const { method, params } = buildRequest(args);
    requestId = randomUUID();
    socket.send(
      JSON.stringify({
        type: "req",
        id: requestId,
        method,
        params
      })
    );

    return;
  }

  if (frame.type === "res" && frame.id === requestId) {
    if (frame.ok !== true) {
      finish(1);
      return;
    }

    if (args.method !== "chat.send" || !args.keepOpen) {
      finish(0);
    }

    if (args.method === "chat.send") {
      runId = frame.payload?.runId || null;
    }

    return;
  }

  if (frame.type === "event" && frame.event === "chat") {
    const state = frame.payload?.state;

    if (!args.keepOpen && (state === "final" || state === "error" || state === "aborted")) {
      finish(state === "final" ? 0 : 1);
    }
  }
});

socket.addEventListener("error", (event) => {
  console.error("[ws] error", event.message || event.type || "unknown websocket error");
});

socket.addEventListener("close", (event) => {
  clearTimeout(timeout);

  if (!helloSeen) {
    console.error(`[ws] closed before handshake completed (${event.code})`);
    process.exit(1);
  }

  if (runId && args.keepOpen) {
    console.error(`[ws] closed while run ${runId} was still active (${event.code})`);
    process.exit(1);
  }
});

function buildWsUrl(options) {
  const base = new URL(options.baseUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws";
  base.searchParams.set("agent_id", options.agentId);
  base.searchParams.set("workspace_id", options.workspaceId);
  base.searchParams.set("user_id", options.userId);
  base.searchParams.set("session_key", options.sessionKey);
  return base.toString();
}

function buildRequest(options) {
  if (options.message) {
    return {
      method: "chat.send",
      params: {
        agent_id: options.agentId,
        workspace_id: options.workspaceId,
        sessionKey: options.sessionKey,
        message: options.message,
        deliver: false,
        idempotencyKey: randomUUID()
      }
    };
  }

  switch (options.method) {
    case "sessions.list":
      return { method: "sessions.list", params: { limit: options.limit } };
    case "models.list":
      return { method: "models.list", params: {} };
    case "config.get":
      return { method: "config.get", params: {} };
    case "sessions.usage":
      return { method: "sessions.usage", params: {} };
    case "connect-only":
      return { method: "connect", params: {} };
    default:
      throw new Error(`Unsupported method: ${options.method}`);
  }
}

function parseArgs(argv, current) {
  const next = { ...current };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--base-url":
        next.baseUrl = argv[++index];
        break;
      case "--agent-id":
        next.agentId = argv[++index];
        break;
      case "--workspace-id":
        next.workspaceId = argv[++index];
        break;
      case "--user-id":
        next.userId = argv[++index];
        break;
      case "--session-key":
        next.sessionKey = argv[++index];
        break;
      case "--method":
        next.method = argv[++index];
        break;
      case "--message":
        next.message = argv[++index];
        next.method = "chat.send";
        break;
      case "--limit":
        next.limit = Number.parseInt(argv[++index], 10);
        break;
      case "--timeout-ms":
        next.timeoutMs = Number.parseInt(argv[++index], 10);
        break;
      case "--keep-open":
        next.keepOpen = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return next;
}

function printHelp() {
  console.log(`Usage:
  node scripts/runtime-ws-client.mjs [options]

Options:
  --base-url http://127.0.0.1:4000
  --agent-id <uuid>
  --workspace-id <uuid>
  --user-id <uuid>
  --session-key <user-id>:<workspace-id>:<agent-id>
  --method sessions.list|models.list|config.get|sessions.usage|connect-only
  --message "Fix the failing test"
  --limit 20
  --timeout-ms 15000
  --keep-open

Examples:
  pnpm run debug:orchestrator:ws
  pnpm run debug:orchestrator:ws --method models.list
  pnpm run debug:orchestrator:ws --message "Fix the failing test"`);
}

function safeClose(ws) {
  try {
    ws.close();
  } catch {
    // no-op
  }
}

function finish(exitCode) {
  clearTimeout(timeout);
  safeClose(socket);
  setTimeout(() => process.exit(exitCode), 50);
}
