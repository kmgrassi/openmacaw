#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");
const DEFAULT_LAUNCHER_URL = "http://127.0.0.1:4100";
const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:4000";
const DEFAULT_GATEWAY_MESSAGE = "hello from smoke:agents";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SINCE = "10m";

const SCENARIOS = [
  { id: "platform-preflight", label: "Platform preflight" },
  { id: "gateway-hello", label: "Gateway hello" },
  { id: "plain-message", label: "Plain message" },
  { id: "planner-tool-call", label: "Planner tool call" },
  { id: "direct-tool-exec", label: "Direct tool exec" },
  { id: "manager-tick", label: "Manager tick" },
  { id: "manager-dispatch", label: "Manager dispatch" },
  { id: "local-relay", label: "Local relay" },
  { id: "persistence", label: "Persistence" },
  { id: "logs", label: "Logs" },
  { id: "snapshot", label: "Snapshot" },
];

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.listScenarios) {
    for (const scenario of SCENARIOS) console.log(scenario.id);
    return;
  }

  const runner = new AgentsSmoke(opts);
  const summary = await runner.run();

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }

  process.exitCode = summary.status === "failed" || (opts.failOnSkip && summary.counts.skipped > 0) ? 1 : 0;
}

class AgentsSmoke {
  constructor(opts) {
    this.opts = opts;
    this.context = {
      workspace_id: opts.workspaceId || null,
      planner_agent_id: opts.plannerAgentId || null,
      manager_agent_id: opts.managerAgentId || null,
      agent_id: opts.agentId || opts.plannerAgentId || opts.managerAgentId || null,
      request_id: null,
      session_key: opts.sessionKey || null,
      run_id: null,
      message_id: null,
      tool_call_id: null,
    };
  }

  async run() {
    const startedAt = new Date();
    const requested = new Set(this.opts.scenarios);
    const results = [];

    for (const scenario of SCENARIOS) {
      if (!requested.has(scenario.id)) continue;
      results.push(await this.runScenario(scenario));
    }

    const finishedAt = new Date();
    const counts = countStatuses(results);

    return {
      schema_version: 1,
      status: counts.failed > 0 ? "failed" : "passed",
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      workspace_id: this.context.workspace_id,
      agent_id: this.context.agent_id,
      planner_agent_id: this.context.planner_agent_id,
      manager_agent_id: this.context.manager_agent_id,
      request_id: this.context.request_id,
      session_key: this.context.session_key,
      run_id: this.context.run_id,
      message_id: this.context.message_id,
      tool_call_id: this.context.tool_call_id,
      counts,
      scenarios: results,
      next_commands: nextCommands(this.opts, results, this.context),
    };
  }

  async runScenario(scenario) {
    const startedAt = Date.now();

    try {
      const result = await this.dispatchScenario(scenario.id);
      return {
        id: scenario.id,
        label: scenario.label,
        duration_ms: Date.now() - startedAt,
        ...result,
      };
    } catch (error) {
      return {
        id: scenario.id,
        label: scenario.label,
        status: "failed",
        duration_ms: Date.now() - startedAt,
        error: error.message,
        next_commands: failureCommandsFor(scenario.id, this.opts, this.context),
      };
    }
  }

  async dispatchScenario(id) {
    switch (id) {
      case "platform-preflight":
        return this.platformPreflight();
      case "gateway-hello":
        return this.gatewayHello();
      case "plain-message":
        return this.plainMessage();
      case "planner-tool-call":
        return skip("planner work-item smoke is not implemented in this repo yet", [
          "Implement pnpm run smoke:planner-work-item from docs/manual-agent-testing-scope.md item 6.",
        ]);
      case "direct-tool-exec":
        return skip("dev runtime tool execution endpoint is not implemented yet", [
          "Implement pnpm run agent:tool-exec from docs/manual-agent-testing-scope.md item 4.",
        ]);
      case "manager-tick":
        return this.managerTick();
      case "manager-dispatch":
        return skip("manager dispatch smoke is not implemented yet", [
          "Implement pnpm run smoke:manager-dispatch from docs/manual-agent-testing-scope.md item 7.",
        ]);
      case "local-relay":
        return this.localRelay();
      case "persistence":
        return skip("persistence assertions need planner/message smoke artifacts that are not available yet", [
          "Run planner and gateway smokes with JSON artifacts once those commands are available.",
        ]);
      case "logs":
        return this.logs();
      case "snapshot":
        return this.snapshot();
      default:
        throw new Error(`unknown scenario: ${id}`);
    }
  }

  async platformPreflight() {
    if (!this.opts.platformArtifact) {
      return skip("no --platform-artifact was provided", [
        "Run the platform doctor or smoke command with JSON output and pass --platform-artifact <path>.",
      ]);
    }

    const artifactPath = path.resolve(process.cwd(), this.opts.platformArtifact);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    const canChat = extractCanChat(artifact);
    const ok = artifact.ok === true || artifact.status === "passed" || canChat === true;

    this.mergeContext(extractIds(artifact));

    return {
      status: ok ? "passed" : "failed",
      proof: {
        artifact: artifactPath,
        ok: artifact.ok ?? null,
        status: artifact.status ?? null,
        can_chat: canChat,
      },
      error: ok ? null : "platform artifact does not report a chat-ready agent",
      next_commands: ok ? [] : ["Re-run the platform doctor for the selected agent/workspace."],
    };
  }

  async gatewayHello() {
    const result = await runJsonCommand("node", [
      scriptPath("gateway-smoke.mjs"),
      "--json",
      ...gatewayArgs(this.opts, this.context),
    ], this.opts.commandTimeoutMs);

    const payload = result.json;
    this.mergeContext({
      workspace_id: payload.scope?.workspace_id,
      agent_id: payload.scope?.agent_id,
      session_key: payload.session_key,
      request_id: payload.request_ids?.connect,
    });

    return commandScenario(payload.ok === true, result, {
      proof: {
        websocket_url: payload.websocket_url,
        request_id: payload.request_ids?.connect ?? null,
        checks: summarizeChecks(payload.checks),
      },
      next_commands: payload.next_steps || [],
    });
  }

  async plainMessage() {
    if (this.opts.noMessage) {
      return skip("plain-message scenario disabled by --no-message", []);
    }

    const result = await runJsonCommand("node", [
      scriptPath("gateway-smoke.mjs"),
      "--json",
      "--message",
      this.opts.message,
      ...gatewayArgs(this.opts, this.context),
    ], this.opts.commandTimeoutMs);

    const payload = result.json;
    const chatCheck = Array.isArray(payload.checks)
      ? payload.checks.find((check) => check.name === "chat.send")
      : null;

    this.mergeContext({
      workspace_id: payload.scope?.workspace_id,
      agent_id: payload.scope?.agent_id,
      session_key: payload.session_key,
      request_id: payload.request_ids?.["chat.send"],
      run_id: payload.run_id,
    });

    const terminalOk = payload.ok === true && chatCheck?.status === "passed" && chatCheck.state !== "error";

    return commandScenario(terminalOk, result, {
      proof: {
        request_id: payload.request_ids?.["chat.send"] ?? null,
        run_id: payload.run_id ?? null,
        state: chatCheck?.state ?? null,
        error_code: chatCheck?.error_code ?? null,
      },
      next_commands: payload.next_steps || [],
    });
  }

  async managerTick() {
    if (!this.context.workspace_id) {
      return skip("workspace id is required for manager status", ["Pass --workspace-id <workspace-id>."]);
    }

    const args = [
      scriptPath("manager-smoke.mjs"),
      "--workspace-id",
      this.context.workspace_id,
      "--launcher-url",
      this.opts.launcherUrl,
    ];

    if (this.context.manager_agent_id) args.push("--agent-id", this.context.manager_agent_id);

    const result = await runJsonishCommand("node", args, this.opts.commandTimeoutMs);
    this.mergeContext({
      manager_agent_id: result.json?.agent_id,
    });

    return commandScenario(result.status === 0, result, {
      proof: result.json
        ? {
            workspace_id: result.json.workspace_id ?? null,
            agent_id: result.json.agent_id ?? null,
            provider: result.json.provider ?? null,
            model: result.json.model ?? null,
            last_tick_at: result.json.last_tick_at ?? null,
          }
        : null,
    });
  }

  async localRelay() {
    if (!this.context.workspace_id) {
      return skip("workspace id is required for local relay health", ["Pass --workspace-id <workspace-id>."]);
    }

    const result = await runJsonCommand("node", [
      scriptPath("local-relay-smoke.mjs"),
      "--json",
      "--workspace-id",
      this.context.workspace_id,
      "--orchestrator-url",
      this.opts.orchestratorUrl,
      "--target-runner-kind",
      this.opts.targetRunnerKind,
      ...(this.opts.model ? ["--model", this.opts.model] : []),
    ], this.opts.commandTimeoutMs);

    const payload = result.json;

    return commandScenario(payload.ok === true, result, {
      proof: {
        status: payload.status ?? null,
        reason: payload.reason ?? null,
        helper_count: Array.isArray(payload.helpers) ? payload.helpers.length : 0,
        filters: payload.filters ?? {},
      },
    });
  }

  async logs() {
    if (!this.context.run_id) {
      return skip("no run id is available to correlate in runtime logs", [
        "Run the plain-message scenario or pass an artifact that includes run_id.",
      ]);
    }

    const args = [scriptPath("runtime-logs.mjs"), "--json", "--since", this.opts.since, "--last", "50"];
    args.push("--run-id", this.context.run_id);

    const result = await runJsonCommand("node", args, this.opts.commandTimeoutMs);
    const entries = Array.isArray(result.json.entries) ? result.json.entries : [];
    const expectedId = this.context.run_id;

    if (expectedId && entries.length === 0) {
      return {
        status: "failed",
        proof: {
          expected_id: expectedId,
          entries: 0,
          missing: result.json.missing || [],
        },
        error: "no runtime log entries matched the latest run/session id",
        next_commands: [`pnpm run logs:runtime -- --since ${this.opts.since}`],
      };
    }

    return commandScenario(result.status === 0, result, {
      proof: {
        matched_id: expectedId ?? null,
        entries: entries.length,
        missing: result.json.missing || [],
      },
    });
  }

  async snapshot() {
    const args = [
      scriptPath("runtime-snapshot.mjs"),
      "--json",
      "--launcher-url",
      this.opts.launcherUrl,
      "--orchestrator-url",
      this.opts.orchestratorUrl,
    ];

    if (this.context.workspace_id) args.push("--workspace-id", this.context.workspace_id);
    if (this.context.manager_agent_id) args.push("--agent-id", this.context.manager_agent_id);
    if (this.opts.targetRunnerKind) args.push("--target-runner-kind", this.opts.targetRunnerKind);
    if (this.opts.model) args.push("--model", this.opts.model);

    const result = await runJsonCommand("node", args, this.opts.commandTimeoutMs);
    const payload = result.json;

    return commandScenario(payload.ok === true, result, {
      proof: {
        launcher: payload.services?.launcher?.status ?? "unknown",
        orchestrator: payload.services?.orchestrator?.status ?? "unknown",
        manager: payload.manager?.status ?? null,
        local_runtime: payload.local_runtime?.status ?? null,
        recent_failures: Array.isArray(payload.recent_failures) ? payload.recent_failures.length : 0,
      },
      next_commands: payload.inspect?.commands || [],
    });
  }

  mergeContext(ids) {
    for (const [key, value] of Object.entries(ids || {})) {
      if (value) this.context[key] = value;
    }
  }
}

function parseArgs(argv) {
  const opts = {
    json: false,
    listScenarios: false,
    failOnSkip: false,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || process.env.MANAGER_WORKSPACE_ID || "",
    agentId: process.env.RUNTIME_AGENT_ID || "",
    plannerAgentId: process.env.PLANNER_AGENT_ID || "",
    managerAgentId: process.env.MANAGER_AGENT_ID || "",
    userId: process.env.RUNTIME_USER_ID || "",
    sessionKey: process.env.RUNTIME_SESSION_KEY || "",
    launcherUrl: process.env.LAUNCHER_URL || DEFAULT_LAUNCHER_URL,
    orchestratorUrl: process.env.ORCHESTRATOR_URL || DEFAULT_ORCHESTRATOR_URL,
    targetRunnerKind: process.env.RUNTIME_TARGET_RUNNER_KIND || "openai_compatible",
    model: process.env.RUNTIME_MODEL || "",
    message: process.env.RUNTIME_AGENTS_SMOKE_MESSAGE || DEFAULT_GATEWAY_MESSAGE,
    noMessage: false,
    since: process.env.RUNTIME_AGENTS_SMOKE_LOG_SINCE || DEFAULT_SINCE,
    commandTimeoutMs: numberFromEnv("RUNTIME_AGENTS_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    platformArtifact: "",
    scenarios: SCENARIOS.map((scenario) => scenario.id),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") continue;
    if (arg === "--json") opts.json = true;
    else if (arg === "--list-scenarios") opts.listScenarios = true;
    else if (arg === "--fail-on-skip") opts.failOnSkip = true;
    else if (arg === "--no-message") opts.noMessage = true;
    else if (arg === "--workspace-id" && next) opts.workspaceId = next, index += 1;
    else if (arg === "--agent-id" && next) opts.agentId = next, index += 1;
    else if (arg === "--planner-agent-id" && next) opts.plannerAgentId = next, index += 1;
    else if (arg === "--manager-agent-id" && next) opts.managerAgentId = next, index += 1;
    else if (arg === "--user-id" && next) opts.userId = next, index += 1;
    else if (arg === "--session-key" && next) opts.sessionKey = next, index += 1;
    else if (arg === "--launcher-url" && next) opts.launcherUrl = next, index += 1;
    else if (arg === "--orchestrator-url" && next) opts.orchestratorUrl = next, index += 1;
    else if (arg === "--target-runner-kind" && next) opts.targetRunnerKind = next, index += 1;
    else if (arg === "--model" && next) opts.model = next, index += 1;
    else if (arg === "--message" && next) opts.message = next, index += 1;
    else if (arg === "--since" && next) opts.since = next, index += 1;
    else if (arg === "--timeout-ms" && next) opts.commandTimeoutMs = parsePositiveInt(next, "--timeout-ms"), index += 1;
    else if (arg === "--platform-artifact" && next) opts.platformArtifact = next, index += 1;
    else if (arg === "--scenario" && next) opts.scenarios = parseScenarioList(next), index += 1;
    else if (arg === "--skip-scenario" && next) opts.scenarios = opts.scenarios.filter((id) => !parseScenarioList(next).includes(id)), index += 1;
    else if (arg === "--help" || arg === "-h") printUsageAndExit();
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  opts.workspaceId = opts.workspaceId.trim();
  opts.agentId = opts.agentId.trim();
  opts.plannerAgentId = opts.plannerAgentId.trim();
  opts.managerAgentId = opts.managerAgentId.trim();
  opts.userId = opts.userId.trim();
  opts.sessionKey = opts.sessionKey.trim();
  opts.launcherUrl = trimTrailingSlash(opts.launcherUrl);
  opts.orchestratorUrl = trimTrailingSlash(opts.orchestratorUrl);
  opts.targetRunnerKind = opts.targetRunnerKind.trim();
  opts.model = opts.model.trim();
  opts.message = opts.message.trim();
  opts.platformArtifact = opts.platformArtifact.trim();
  opts.scenarios = [...new Set(opts.scenarios)];

  for (const scenario of opts.scenarios) {
    if (!SCENARIOS.some((entry) => entry.id === scenario)) {
      throw new Error(`unknown scenario '${scenario}'. Run --list-scenarios for valid values.`);
    }
  }

  return opts;
}

function printUsageAndExit() {
  console.log(`Usage: pnpm run smoke:agents -- --workspace-id <workspace-id> [options]

Options:
  --workspace-id <id>          Runtime workspace id.
  --agent-id <id>              Generic gateway agent id.
  --planner-agent-id <id>      Planner agent id.
  --manager-agent-id <id>      Manager agent id.
  --user-id <id>               Gateway user id.
  --session-key <key>          Gateway session key.
  --launcher-url <url>         Default: ${DEFAULT_LAUNCHER_URL}
  --orchestrator-url <url>     Default: ${DEFAULT_ORCHESTRATOR_URL}
  --target-runner-kind <kind>  Local relay runner kind. Default: openai_compatible
  --model <name>               Local relay model filter.
  --message <text>             Plain-message prompt. Default: "${DEFAULT_GATEWAY_MESSAGE}"
  --no-message                 Skip chat.send inside the plain-message scenario.
  --since <duration>           Runtime log search window. Default: ${DEFAULT_SINCE}
  --timeout-ms <ms>            Per-command timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --platform-artifact <path>   JSON output from a platform doctor/smoke command.
  --scenario <csv>             Run only these scenario ids.
  --skip-scenario <csv>        Remove scenario ids from the matrix.
  --fail-on-skip               Exit non-zero when any selected scenario is skipped.
  --list-scenarios             Print scenario ids and exit.
  --json                       Print machine-readable JSON.

Environment:
  RUNTIME_WORKSPACE_ID, RUNTIME_AGENT_ID, PLANNER_AGENT_ID, MANAGER_AGENT_ID,
  RUNTIME_USER_ID, RUNTIME_SESSION_KEY, LAUNCHER_URL, ORCHESTRATOR_URL,
  RUNTIME_TARGET_RUNNER_KIND, RUNTIME_MODEL, RUNTIME_AGENTS_SMOKE_MESSAGE,
  RUNTIME_AGENTS_SMOKE_LOG_SINCE, RUNTIME_AGENTS_SMOKE_TIMEOUT_MS`);
  process.exit(0);
}

function gatewayArgs(opts, context) {
  const args = ["--base-url", opts.orchestratorUrl];
  const agentId = context.agent_id || opts.agentId || opts.plannerAgentId || opts.managerAgentId;

  if (agentId) args.push("--agent-id", agentId);
  if (context.workspace_id) args.push("--workspace-id", context.workspace_id);
  if (opts.userId) args.push("--user-id", opts.userId);
  if (context.session_key) args.push("--session-key", context.session_key);
  return args;
}

function parseScenarioList(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

async function runJsonCommand(command, args, timeoutMs) {
  const result = await runCommand(command, args, timeoutMs);
  result.json = parseJsonOutput(result.stdout);
  return result;
}

async function runJsonishCommand(command, args, timeoutMs) {
  const result = await runCommand(command, args, timeoutMs);
  result.json = parseJsonOutput(result.stdout, { optional: true });
  return result;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ command: commandString(command, args), status: 1, stdout, stderr, error: error.message, timed_out: false });
    });

    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({
        command: commandString(command, args),
        status: timedOut ? 124 : (status ?? 1),
        stdout,
        stderr,
        error: timedOut ? `timed out after ${timeoutMs}ms` : null,
        timed_out: timedOut,
      });
    });
  });
}

function parseJsonOutput(stdout, opts = {}) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    if (opts.optional) return null;
    throw new Error("command did not emit JSON");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start >= 0) {
      return JSON.parse(trimmed.slice(start + 1));
    }

    if (opts.optional) return null;
    throw new Error("command output was not valid JSON");
  }
}

function commandScenario(ok, result, extra = {}) {
  return {
    status: ok && result.status === 0 ? "passed" : "failed",
    command: result.command,
    exit_code: result.status,
    error: result.error || stderrSummary(result.stderr) || (ok ? null : "command reported failure"),
    ...extra,
  };
}

function skip(reason, nextCommands) {
  return {
    status: "skipped",
    reason,
    next_commands: nextCommands,
  };
}

function extractCanChat(value) {
  return firstDefined(
    value.canChat,
    value.can_chat,
    value.agent?.canChat,
    value.agent?.can_chat,
    value.diagnostic?.canChat,
    value.diagnostic?.can_chat,
    value.summary?.canChat,
    value.summary?.can_chat,
  );
}

function extractIds(value) {
  return {
    workspace_id: firstDefined(value.workspaceId, value.workspace_id, value.workspace?.id),
    agent_id: firstDefined(value.agentId, value.agent_id, value.agent?.id),
    request_id: firstDefined(value.requestId, value.request_id),
    session_key: firstDefined(value.sessionKey, value.session_key),
    run_id: firstDefined(value.runId, value.run_id),
    message_id: firstDefined(value.messageId, value.message_id),
    tool_call_id: firstDefined(value.toolCallId, value.tool_call_id),
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function summarizeChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.map((check) => ({
    name: check.name,
    status: check.status,
    request_id: check.request_id ?? null,
    state: check.state ?? null,
  }));
}

function countStatuses(results) {
  return {
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
}

function nextCommands(opts, results, context) {
  const commands = [];

  for (const result of results) {
    if (result.status === "failed" || result.status === "skipped") {
      commands.push(...(result.next_commands || []));
    }
  }

  if (results.some((result) => result.status === "failed")) {
    commands.push("pnpm run doctor:runtime");
    commands.push(`pnpm run logs:runtime -- --since ${opts.since}`);
  }

  if (context.run_id) {
    commands.push(`pnpm run logs:runtime -- --since ${opts.since} --run-id ${context.run_id}`);
  } else if (context.session_key) {
    commands.push(`pnpm run logs:runtime -- --since ${opts.since} --session-key ${context.session_key}`);
  }

  commands.push("pnpm run snapshot:runtime -- --json");
  return [...new Set(commands)].filter(Boolean);
}

function failureCommandsFor(id, opts, context) {
  switch (id) {
    case "gateway-hello":
    case "plain-message":
      return ["pnpm run smoke:gateway -- --json", "pnpm run debug:orchestrator:ws"];
    case "manager-tick":
      return context.workspace_id
        ? [`pnpm run smoke:manager -- --workspace-id ${context.workspace_id}`]
        : ["pnpm run smoke:manager -- --workspace-id <workspace-id>"];
    case "local-relay":
      return context.workspace_id
        ? [`pnpm run smoke:local-relay -- --workspace-id ${context.workspace_id}`]
        : ["pnpm run smoke:local-relay -- --workspace-id <workspace-id>"];
    case "logs":
      return [`pnpm run logs:runtime -- --since ${opts.since}`];
    case "snapshot":
      return ["pnpm run snapshot:runtime -- --json"];
    default:
      return ["pnpm run doctor:runtime"];
  }
}

function printSummary(summary) {
  console.log(`[agents-smoke] ${summary.status}`);
  console.log(
    `[agents-smoke] passed=${summary.counts.passed} failed=${summary.counts.failed} skipped=${summary.counts.skipped}`,
  );

  for (const scenario of summary.scenarios) {
    const detail = scenario.error || scenario.reason || "";
    console.log(`[agents-smoke] ${scenario.status} ${scenario.id}${detail ? ` - ${detail}` : ""}`);
  }

  if (summary.next_commands.length > 0) {
    console.log("[agents-smoke] next commands:");
    for (const command of summary.next_commands) console.log(`- ${command}`);
  }
}

function stderrSummary(stderr) {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  return lines.length > 0 ? lines.slice(-3).join("\n") : null;
}

function scriptPath(name) {
  return path.join(ROOT_DIR, "scripts", name);
}

function commandString(command, args) {
  return [command, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(`[agents-smoke] failed: ${error.message}`);
  process.exit(1);
});
