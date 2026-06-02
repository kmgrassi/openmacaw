#!/usr/bin/env node

import { TranscriptRecorder, summarizeHttpExchange } from "./agent-transcript.mjs";

const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:4000";
const DEFAULT_TIMEOUT_MS = 5_000;

function parseArgs(argv) {
  const opts = {
    orchestratorUrl: process.env.ORCHESTRATOR_URL || DEFAULT_ORCHESTRATOR_URL,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || process.env.MANAGER_WORKSPACE_ID || "",
    targetRunnerKind: process.env.RUNTIME_TARGET_RUNNER_KIND || "openai_compatible",
    model: process.env.RUNTIME_MODEL || "",
    requiredCapabilities: stringList(process.env.RUNTIME_REQUIRED_CAPABILITIES || ""),
    timeoutMs: numberFromEnv("LOCAL_RELAY_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    json: false,
    recordPath: process.env.RUNTIME_AGENT_TRANSCRIPT || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") continue;
    if (arg === "--json") opts.json = true;
    else if (arg === "--orchestrator-url" && next) opts.orchestratorUrl = next, index += 1;
    else if (arg === "--workspace-id" && next) opts.workspaceId = next, index += 1;
    else if (arg === "--target-runner-kind" && next) opts.targetRunnerKind = next, index += 1;
    else if (arg === "--model" && next) opts.model = next, index += 1;
    else if (arg === "--required-capability" && next) opts.requiredCapabilities.push(next), index += 1;
    else if (arg === "--required-capabilities" && next) opts.requiredCapabilities.push(...stringList(next)), index += 1;
    else if (arg === "--timeout-ms" && next) opts.timeoutMs = parsePositiveInt(next, "--timeout-ms"), index += 1;
    else if (arg === "--record" && next) opts.recordPath = next, index += 1;
    else if (arg === "--help" || arg === "-h") printUsageAndExit();
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  opts.orchestratorUrl = opts.orchestratorUrl.replace(/\/+$/, "");
  opts.workspaceId = opts.workspaceId.trim();
  opts.targetRunnerKind = opts.targetRunnerKind.trim();
  opts.model = opts.model.trim();
  opts.requiredCapabilities = [...new Set(opts.requiredCapabilities.map((value) => value.trim()).filter(Boolean))];
  return opts;
}

function printUsageAndExit() {
  console.log(`Usage: pnpm run smoke:local-relay -- --workspace-id <workspace-id>

Options:
  --workspace-id <id>              Workspace whose helper should be online.
  --target-runner-kind <kind>      Default: openai_compatible
  --model <name>                   Require this model to be registered.
  --required-capability <name>     Require a helper capability. Repeatable.
  --required-capabilities <csv>    Comma-separated capability list.
  --orchestrator-url <url>         Default: ${DEFAULT_ORCHESTRATOR_URL}
  --timeout-ms <ms>                Default: ${DEFAULT_TIMEOUT_MS}
  --json                           Print the full payload.
  --record <path>                  Write a redacted JSONL transcript.`);
  process.exit(0);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.workspaceId) {
    throw new Error("workspace id is required. Pass --workspace-id or set RUNTIME_WORKSPACE_ID.");
  }

  const recorder = new TranscriptRecorder(opts.recordPath, {
    command: "local-relay-smoke",
    orchestrator_url: opts.orchestratorUrl,
    workspace_id: opts.workspaceId,
    target_runner_kind: opts.targetRunnerKind,
    model_present: Boolean(opts.model),
    required_capabilities: opts.requiredCapabilities,
  });
  const result = await captureJson(localRuntimeHealthUrl(opts), opts.timeoutMs);
  recorder.record("relay.health.response", summarizeHttpExchange({ method: "GET", ...result }));
  const payload = result.body || {};
  const report = {
    ok: result.ok && payload.ok === true,
    status: payload.status || "unknown",
    reason: payload.reason || (result.ok ? null : result.error),
    filters: payload.filters || {},
    helpers: payload.helpers || [],
    url: result.url,
    transcript_path: opts.recordPath || null,
  };
  recorder.close({ ok: report.ok, status: report.status, helpers_count: report.helpers.length });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report);
  }

  process.exitCode = report.ok ? 0 : 1;
}

async function captureJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url,
      body: text ? JSON.parse(text) : null,
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

function localRuntimeHealthUrl(opts) {
  const url = new URL("/api/v1/local-runtime/health", opts.orchestratorUrl);
  url.searchParams.set("workspace_id", opts.workspaceId);
  url.searchParams.set("target_runner_kind", opts.targetRunnerKind);
  if (opts.model) url.searchParams.set("model", opts.model);
  if (opts.requiredCapabilities.length > 0) {
    url.searchParams.set("required_capabilities", opts.requiredCapabilities.join(","));
  }
  return url.href;
}

function printSummary(report) {
  console.log(`[local-relay-smoke] ${report.ok ? "ready" : "not ready"}`);
  console.log(`status: ${report.status}`);
  console.log(`reason: ${report.reason || "ready"}`);
  console.log(`helpers: ${report.helpers.length}`);

  for (const helper of report.helpers) {
    const runners = Array.isArray(helper.runners) ? helper.runners : [];
    const runnerText = runners.map((runner) => `${runner.runner_kind}:${runner.model || "unknown-model"}`).join(", ");
    console.log(`- workspace=${helper.workspace_id} machine=${helper.machine_id} status=${helper.status} runners=${runnerText || "none"}`);
  }
}

function stringList(value) {
  return String(value || "")
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
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

main().catch((error) => {
  console.error(`[local-relay-smoke] failed: ${error.message}`);
  process.exit(1);
});
