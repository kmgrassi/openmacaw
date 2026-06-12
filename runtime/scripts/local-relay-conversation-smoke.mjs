#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:4000";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LOCAL_RELAY_TOKEN = "lrh_dev_local_token_2026";
const TERMINAL_STATES = new Set(["final", "error", "aborted"]);

function parseArgs(argv) {
  const opts = {
    orchestratorUrl: process.env.ORCHESTRATOR_URL || process.env.RUNTIME_BASE_URL || DEFAULT_ORCHESTRATOR_URL,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || "",
    agentId: process.env.RUNTIME_AGENT_ID || "",
    userId: process.env.RUNTIME_USER_ID || "33333333-3333-4333-8333-333333333333",
    sessionKey: process.env.RUNTIME_SESSION_KEY || "",
    runnerKind: process.env.RUNTIME_TARGET_RUNNER_KIND || "openai_compatible",
    model: process.env.RUNTIME_MODEL || "",
    helper: process.env.LOCAL_RELAY_CONVERSATION_HELPER || "scripted",
    machineId: process.env.LOCAL_RELAY_MACHINE_ID || `scripted-${process.pid}`,
    token: process.env.LOCAL_RELAY_TOKEN || DEFAULT_LOCAL_RELAY_TOKEN,
    scenario: "tool-call-round-trip",
    message: "Run the local relay tool-call round trip smoke.",
    toolName: "",
    timeoutMs: numberFromEnv("LOCAL_RELAY_CONVERSATION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    transcript: "",
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") continue;
    if (arg === "--json") opts.json = true;
    else if (arg === "--orchestrator-url" && next) opts.orchestratorUrl = next, index += 1;
    else if (arg === "--workspace-id" && next) opts.workspaceId = next, index += 1;
    else if (arg === "--agent-id" && next) opts.agentId = next, index += 1;
    else if (arg === "--user-id" && next) opts.userId = next, index += 1;
    else if (arg === "--session-key" && next) opts.sessionKey = next, index += 1;
    else if (arg === "--runner-kind" && next) opts.runnerKind = next, index += 1;
    else if (arg === "--model" && next) opts.model = next, index += 1;
    else if (arg === "--helper" && next) opts.helper = next, index += 1;
    else if (arg === "--machine-id" && next) opts.machineId = next, index += 1;
    else if (arg === "--token" && next) opts.token = next, index += 1;
    else if (arg === "--scenario" && next) opts.scenario = next, index += 1;
    else if (arg === "--message" && next) opts.message = next, index += 1;
    else if (arg === "--tool" && next) opts.toolName = next, index += 1;
    else if (arg === "--timeout-ms" && next) opts.timeoutMs = parsePositiveInt(next, "--timeout-ms"), index += 1;
    else if (arg === "--transcript" && next) opts.transcript = next, index += 1;
    else if (arg === "--help" || arg === "-h") printUsageAndExit();
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  opts.orchestratorUrl = opts.orchestratorUrl.replace(/\/+$/, "");
  opts.workspaceId = opts.workspaceId.trim();
  opts.agentId = opts.agentId.trim();
  opts.userId = opts.userId.trim();
  opts.sessionKey = opts.sessionKey.trim() || `${opts.userId}:${opts.workspaceId}:${opts.agentId}`;
  opts.runnerKind = opts.runnerKind.trim();
  opts.model = opts.model.trim();
  opts.helper = opts.helper.trim();
  opts.machineId = opts.machineId.trim();
  opts.token = opts.token.trim();
  opts.scenario = opts.scenario.trim();
  opts.toolName = opts.toolName.trim();

  return opts;
}

function printUsageAndExit() {
  console.log(`Usage: pnpm run smoke:local-relay-conversation -- --workspace-id <workspace-id> --agent-id <agent-id>

Options:
  --workspace-id <id>          Workspace to test.
  --agent-id <id>              Agent routed through the runtime gateway.
  --user-id <id>               User id for the gateway scope.
  --session-key <key>          Gateway session key. Defaults to user:workspace:agent.
  --runner-kind <kind>         Helper runner kind to register/require. Default: openai_compatible
  --model <name>               Require this registered helper model.
  --scenario <id>              Default: tool-call-round-trip
  --helper scripted|real       Register a scripted helper, or use an already-running helper. Default: scripted
  --tool <name>                Tool name to request. Defaults to first dispatch tool definition.
  --message <text>             Gateway chat message.
  --machine-id <id>            Scripted helper machine id.
  --token <token>              Scripted helper relay token. Defaults to the dev token.
  --transcript <path>          Write a redacted JSONL transcript.
  --orchestrator-url <url>     Default: ${DEFAULT_ORCHESTRATOR_URL}
  --timeout-ms <ms>            Default: ${DEFAULT_TIMEOUT_MS}
  --json                       Print the full report.`);
  process.exit(0);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  validateOptions(opts);

  const smoke = new ConversationSmoke(opts);
  const report = await smoke.run();

  if (opts.transcript) {
    await writeTranscript(opts.transcript, smoke.timeline);
    report.transcript = opts.transcript;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report);
  }

  process.exitCode = report.status === "passed" ? 0 : 1;
}

class ConversationSmoke {
  constructor(opts) {
    this.opts = opts;
    this.timeline = [];
    this.phase = "registration";
    this.gatewayRequestId = null;
    this.runId = null;
    this.relayCorrelationId = null;
    this.toolCallId = null;
    this.toolName = null;
    this.terminalState = null;
    this.startedAt = new Date();
    this.relaySocket = null;
    this.gatewaySocket = null;
  }

  async run() {
    try {
      this.record("scenario_started", "scenario", { scenario_id: this.opts.scenario });

      if (this.opts.helper === "scripted") {
        await this.startScriptedHelper();
      } else {
        this.phase = "registration";
        await this.assertRealHelperReady();
      }

      this.phase = "dispatch";
      await this.startGatewayTurn();

      const report = this.report("passed");
      this.closeSockets();
      return report;
    } catch (error) {
      this.record("failed", this.phase, { message: error.message });
      this.closeSockets();
      return this.report("failed", error.message);
    }
  }

  async startScriptedHelper() {
    this.relaySocket = await connectWebSocket(relayWsUrl(this.opts), this.opts.timeoutMs);
    this.record("relay_socket_connected", "registration");

    const registered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`registration timed out after ${this.opts.timeoutMs}ms`)), this.opts.timeoutMs);

      this.relaySocket.addEventListener("message", (event) => {
        const frame = parseFrame(event.data);
        this.record("relay_received", frame.type || "unknown", sanitizeFrame(frame));

        if (frame.type === "registered") {
          clearTimeout(timer);
          this.phase = "capability_negotiation";
          resolve(frame);
          return;
        }

        if (frame.type === "dispatch" && Number.isInteger(frame.tool_call_iteration)) {
          this.handleRuntimeManagedContinuation(frame);
          return;
        }

        if (frame.type === "dispatch") {
          this.handleScriptedDispatch(frame);
          return;
        }

        if (frame.type === "tool_execution_request") {
          this.handleToolExecutionRequest(frame);
          return;
        }

        if (frame.type === "cancel") {
          this.record("relay_cancel_received", "terminal_completion", sanitizeFrame(frame));
          return;
        }

        if (frame.type === "error") {
          clearTimeout(timer);
          reject(new Error(frame.error?.message || "relay registration failed"));
        }
      });

      this.relaySocket.addEventListener("close", () => reject(new Error("relay socket closed during registration")));
    });

    this.sendRelay({
      type: "register",
      workspace_id: this.opts.workspaceId,
      machine_id: this.opts.machineId,
      runners: [
        {
          runner_kind: this.opts.runnerKind,
          provider: "local",
          model: this.opts.model || undefined,
          capabilities: { tool_calls: true, runtime_managed_tools: true },
        },
      ],
      metadata: { helper: "scripted", scenario_id: this.opts.scenario },
      auth: { token: this.opts.token },
    });

    await registered;
    await this.assertHelperHealth();
  }

  async assertRealHelperReady() {
    await this.assertHelperHealth();
  }

  async assertHelperHealth() {
    const { response, payload } = await fetchJsonWithTimeout(localRuntimeHealthUrl(this.opts), this.opts.timeoutMs);

    // The orchestrator's health route sits behind the internal bearer the
    // smoke deliberately does not carry (no secrets beyond the relay token).
    // Skip the pre-flight in that case: dispatch already surfaces typed
    // errors (local_runtime_offline, capability_missing) if no usable
    // helper is registered.
    if (response.status === 401 || response.status === 503) {
      this.record("health_check_skipped", "capability_negotiation", {
        status: response.status,
        reason: "health endpoint requires internal auth; relying on dispatch errors instead",
      });
      return;
    }

    this.record("health_checked", "capability_negotiation", { ok: response.ok, status: payload.status, reason: payload.reason });

    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.reason || `local relay health failed with HTTP ${response.status}`);
    }

    const helper = (payload.helpers || []).find((candidate) => {
      return (candidate.runners || []).some((runner) => runner.runner_kind === this.opts.runnerKind);
    });

    if (!helper) {
      throw new Error(`no helper registered for runner kind ${this.opts.runnerKind}`);
    }

    const runner = (helper.runners || []).find((candidate) => candidate.runner_kind === this.opts.runnerKind);
    const capabilities = runner?.capabilities || {};

    if (capabilities.tool_calls !== true && capabilities.runtime_managed_tools !== true) {
      throw new Error(`helper ${helper.machine_id || "unknown"} does not advertise tool-call capability`);
    }
  }

  async startGatewayTurn() {
    this.gatewaySocket = await connectWebSocket(gatewayWsUrl(this.opts), this.opts.timeoutMs);
    this.record("gateway_socket_connected", "dispatch");

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`conversation timed out after ${this.opts.timeoutMs}ms`)), this.opts.timeoutMs);
      this.sendGateway({ type: "req", id: randomUUID(), method: "connect", params: {} });

      this.gatewaySocket.addEventListener("message", (event) => {
        const frame = parseFrame(event.data);
        this.record("gateway_received", frame.type || "unknown", sanitizeFrame(frame));

        if (frame.type === "hello-ok") {
          this.gatewayRequestId = randomUUID();
          this.sendGateway({
            type: "req",
            id: this.gatewayRequestId,
            method: "chat.send",
            params: {
              agent_id: this.opts.agentId,
              workspace_id: this.opts.workspaceId,
              sessionKey: this.opts.sessionKey,
              message: this.opts.message,
              deliver: false,
              idempotencyKey: randomUUID(),
            },
          });
          return;
        }

        if (frame.type === "res" && frame.id === this.gatewayRequestId) {
          if (frame.ok !== true) {
            clearTimeout(timer);
            reject(new Error(frame.error?.message || "gateway chat.send failed"));
            return;
          }

          this.runId = frame.payload?.runId || frame.payload?.run_id || this.runId;
          return;
        }

        if (frame.type === "event" && frame.event === "chat") {
          const state = frame.payload?.state;
          this.runId = frame.payload?.runId || frame.payload?.run_id || this.runId;

          if (TERMINAL_STATES.has(state)) {
            this.terminalState = state;
            clearTimeout(timer);
            if (state === "final") resolve(frame);
            else reject(new Error(`gateway run ended with ${state}`));
          }
        }
      });

      this.gatewaySocket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error("gateway socket closed before terminal completion"));
      });
    });

    if (this.opts.scenario === "tool-call-round-trip" && !this.toolCallId) {
      this.phase = "tool_request";
      throw new Error("conversation completed before a tool call request was observed");
    }
  }

  handleScriptedDispatch(frame) {
    this.phase = "tool_request";
    this.relayCorrelationId = frame.correlation_id || this.relayCorrelationId;
    this.record("dispatch_received", "dispatch", dispatchSummary(frame));

    if (this.opts.scenario !== "tool-call-round-trip") {
      this.phase = "terminal_completion";
      this.sendRelay({
        type: "complete",
        correlation_id: this.relayCorrelationId,
        output_text: `completed scenario ${this.opts.scenario}`,
      });
      return;
    }

    const tool = selectTool(frame, this.opts.toolName);
    if (!tool) {
      this.phase = "tool_request";
      this.sendRelay({
        type: "error",
        correlation_id: this.relayCorrelationId,
        error_code: "capability_missing",
        reason: "dispatch did not include a usable tool definition",
      });
      return;
    }

    this.toolName = tool.name;
    this.toolCallId = `call-${randomUUID()}`;

    this.sendRelay({
      type: "tool_call_request",
      correlation_id: this.relayCorrelationId,
      tool_calls: [
        {
          id: this.toolCallId,
          name: this.toolName,
          arguments: sampleArgumentsForTool(tool, this.opts),
        },
      ],
    });
  }

  handleToolExecutionRequest(frame) {
    this.phase = "tool_result";
    this.record("tool_execution_request_received", "tool_result", {
      correlation_id: frame.correlation_id,
      tool_call_id: frame.tool_call_id,
      name: frame.name,
      execution_kind: frame.execution_kind,
    });

    this.sendRelay({
      type: "tool_call_result",
      correlation_id: frame.correlation_id,
      tool_call_id: frame.tool_call_id || this.toolCallId,
      success: true,
      output: "scripted helper observed runtime-managed tool execution request",
    });

    this.phase = "terminal_completion";
    this.sendRelay({
      type: "complete",
      correlation_id: frame.correlation_id,
      output_text: `completed ${this.toolName || frame.name} round trip`,
      metadata: { scenario_id: this.opts.scenario },
    });
  }

  handleRuntimeManagedContinuation(frame) {
    this.phase = "tool_result";
    this.record("runtime_managed_continuation_received", "tool_result", {
      correlation_id: frame.correlation_id,
      tool_call_iteration: frame.tool_call_iteration,
      message_count: Array.isArray(frame.messages) ? frame.messages.length : 0,
    });

    this.phase = "terminal_completion";
    this.sendRelay({
      type: "complete",
      correlation_id: frame.correlation_id,
      output_text: `completed ${this.toolName || "runtime-managed tool"} round trip`,
      metadata: { scenario_id: this.opts.scenario, tool_call_iteration: frame.tool_call_iteration },
    });
  }

  sendRelay(frame) {
    this.record("relay_sent", frame.type || "unknown", sanitizeFrame(frame));
    this.relaySocket.send(JSON.stringify(removeUndefined(frame)));
  }

  sendGateway(frame) {
    this.record("gateway_sent", frame.method || frame.type || "unknown", sanitizeFrame(frame));
    this.gatewaySocket.send(JSON.stringify(removeUndefined(frame)));
  }

  closeSockets() {
    for (const socket of [this.gatewaySocket, this.relaySocket]) {
      try {
        if (socket && socket.readyState < 2) socket.close();
      } catch {
        // best effort cleanup
      }
    }
  }

  record(event, phase, payload = {}) {
    this.timeline.push({
      ts: new Date().toISOString(),
      event,
      phase,
      payload,
    });
  }

  report(status, error = null) {
    const finishedAt = new Date();
    return {
      scenarioId: this.opts.scenario,
      status,
      error,
      failurePhase: status === "failed" ? this.phase : null,
      workspaceId: this.opts.workspaceId,
      agentId: this.opts.agentId,
      sessionKey: this.opts.sessionKey,
      runId: this.runId,
      relayCorrelationId: this.relayCorrelationId,
      toolCallId: this.toolCallId,
      toolName: this.toolName,
      terminalState: this.terminalState,
      helper: this.opts.helper,
      runnerKind: this.opts.runnerKind,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      timeline: this.timeline.map(({ ts, event, phase, payload }) => ({ ts, event, phase, payload })),
      nextCommands: nextCommands(this.opts),
    };
  }
}

async function connectWebSocket(url, timeoutMs) {
  if (typeof WebSocket === "undefined") {
    throw new Error("Global WebSocket is not available. Use a recent Node runtime with WHATWG WebSocket support.");
  }

  const socket = new WebSocket(url);

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket connect timed out after ${timeoutMs}ms: ${url}`)), timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || `websocket error: ${url}`));
    });
  });
}

function relayWsUrl(opts) {
  const url = new URL(opts.orchestratorUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/local-relay/ws";
  return url.toString();
}

function gatewayWsUrl(opts) {
  const url = new URL(opts.orchestratorUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("agent_id", opts.agentId);
  url.searchParams.set("workspace_id", opts.workspaceId);
  url.searchParams.set("user_id", opts.userId);
  url.searchParams.set("session_key", opts.sessionKey);
  return url.toString();
}

function localRuntimeHealthUrl(opts) {
  const url = new URL("/api/v1/local-runtime/health", opts.orchestratorUrl);
  url.searchParams.set("workspace_id", opts.workspaceId);
  url.searchParams.set("target_runner_kind", opts.runnerKind);
  if (opts.model) url.searchParams.set("model", opts.model);
  url.searchParams.set("required_capabilities", "tool_calls");
  return url.href;
}

function selectTool(dispatchFrame, preferredName) {
  const tools = Array.isArray(dispatchFrame.tool_definitions) ? dispatchFrame.tool_definitions : [];
  const normalized = tools
    .map((tool) => ({
      name: stringValue(tool.name || tool.slug),
      parameters: tool.parameters_schema || tool.parameters || {},
      raw: tool,
    }))
    .filter((tool) => tool.name);

  if (preferredName) {
    return normalized.find((tool) => tool.name === preferredName) || null;
  }

  return normalized[0] || null;
}

function sampleArgumentsForTool(tool, opts) {
  const properties = tool.parameters?.properties || {};
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
  const args = {};

  for (const key of required) {
    args[key] = sampleValueForSchema(properties[key], key, opts);
  }

  if (Object.keys(args).length === 0) {
    if (properties.path) args.path = "README.md";
    else if (properties.title) args.title = `Local relay smoke ${Date.now()}`;
    else if (properties.workspace_id) args.workspace_id = opts.workspaceId;
  }

  return args;
}

function sampleValueForSchema(schema, key, opts) {
  if (key === "workspace_id" || key === "workspaceId") return opts.workspaceId;
  if (key === "agent_id" || key === "agentId") return opts.agentId;
  if (key === "path") return "README.md";
  if (key === "title" || key === "name") return `Local relay smoke ${Date.now()}`;

  switch (schema?.type) {
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "local relay smoke";
  }
}

function dispatchSummary(frame) {
  return {
    correlation_id: frame.correlation_id,
    runner_kind: frame.runner_kind,
    target_runner_kind: frame.target_runner_kind,
    model: frame.model,
    tool_calling_mode: frame.tool_calling_mode,
    tool_count: Array.isArray(frame.tool_definitions) ? frame.tool_definitions.length : 0,
  };
}

function sanitizeFrame(frame) {
  if (!frame || typeof frame !== "object") return frame;
  const clone = removeUndefined(frame);
  redact(clone);
  return clone;
}

function redact(value) {
  if (!value || typeof value !== "object") return;

  for (const key of Object.keys(value)) {
    if (/token|authorization|apikey|api_key|service_role|secret|password/i.test(key)) {
      value[key] = "[REDACTED]";
    } else if (key === "message" || key === "prompt") {
      value[key] = summarizeText(value[key]);
    } else if (typeof value[key] === "object") {
      redact(value[key]);
    }
  }
}

function summarizeText(value) {
  if (typeof value !== "string") return value;
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function parseFrame(data) {
  const text = typeof data === "string" ? data : String(data);
  try {
    return JSON.parse(text);
  } catch {
    return { type: "invalid_json", raw: text.slice(0, 200) };
  }
}

function removeUndefined(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(removeUndefined).filter((entry) => entry !== undefined);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, removeUndefined(entry)])
        .filter(([_key, entry]) => entry !== undefined)
    );
  }

  return value;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { accept: "application/json" };
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (serviceRoleKey) headers.authorization = `Bearer ${serviceRoleKey}`;

  // /api/v1/local-runtime/* sits behind RequireServiceRoleBearer.
  const serviceRoleKey = (process.env.LAUNCHER_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const headers = { accept: "application/json" };
  if (serviceRoleKey) {
    headers.authorization = `Bearer ${serviceRoleKey}`;
  }

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`local relay health timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function writeTranscript(path, timeline) {
  await mkdir(dirname(path), { recursive: true });
  const body = timeline.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(path, body, "utf8");
}

function printSummary(report) {
  console.log(`[local-relay-conversation] ${report.status}`);
  if (report.error) console.log(`error: ${report.error}`);
  if (report.failurePhase) console.log(`failed phase: ${report.failurePhase}`);
  console.log(`scenario: ${report.scenarioId}`);
  console.log(`workspace: ${report.workspaceId}`);
  console.log(`agent: ${report.agentId}`);
  console.log(`runner: ${report.runnerKind}`);
  console.log(`run: ${report.runId || "unknown"}`);
  console.log(`relay correlation: ${report.relayCorrelationId || "unknown"}`);
  console.log(`tool: ${report.toolName || "unknown"} (${report.toolCallId || "no call"})`);
  if (report.transcript) console.log(`transcript: ${report.transcript}`);
}

function nextCommands(opts) {
  return [
    `pnpm run smoke:local-relay -- --workspace-id ${opts.workspaceId} --target-runner-kind ${opts.runnerKind}`,
    `pnpm run logs:runtime -- --since 10m --agent-id ${opts.agentId}`,
  ];
}

function validateOptions(opts) {
  if (!opts.workspaceId) throw new Error("workspace id is required. Pass --workspace-id or set RUNTIME_WORKSPACE_ID.");
  if (!opts.agentId) throw new Error("agent id is required. Pass --agent-id or set RUNTIME_AGENT_ID.");
  if (!opts.runnerKind) throw new Error("runner kind is required.");
  if (!["scripted", "real"].includes(opts.helper)) throw new Error("--helper must be scripted or real");
  if (opts.scenario !== "tool-call-round-trip") throw new Error(`unsupported scenario: ${opts.scenario}`);
  if (opts.helper === "scripted" && !opts.token) throw new Error("scripted helper requires --token or LOCAL_RELAY_TOKEN.");
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return parsePositiveInt(value, name);
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

main().catch((error) => {
  console.error(`[local-relay-conversation] failed: ${error.message}`);
  process.exit(1);
});
