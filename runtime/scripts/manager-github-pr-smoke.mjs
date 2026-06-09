#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const DEFAULT_LAUNCHER_URL = "http://127.0.0.1:4100";
const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:4000";
const DEFAULT_TICK_TIMEOUT_MS = 305_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const SELECT_WORK_ITEM =
  "id,workspace_id,manager_runner_id,title,state,source,metadata,next_poll_at,last_polled_at,updated_at";

loadDotEnv(path.resolve(process.cwd(), ".env"));
loadDotEnv(path.resolve(process.cwd(), "apps/orchestrator/.env"));
loadDotEnv(path.resolve(process.cwd(), "../platform/.env"));

function parseArgs(argv) {
  const opts = {
    launcherUrl: process.env.LAUNCHER_URL || DEFAULT_LAUNCHER_URL,
    orchestratorUrl: process.env.ORCHESTRATOR_URL || DEFAULT_ORCHESTRATOR_URL,
    workspaceId: process.env.MANAGER_WORKSPACE_ID || process.env.RUNTIME_WORKSPACE_ID || "",
    agentId: process.env.MANAGER_AGENT_ID || "",
    repos: [],
    prs: [],
    action: process.env.MANAGER_GITHUB_PR_SMOKE_ACTION || "read-only",
    model: process.env.RUNTIME_MODEL || process.env.MANAGER_MODEL || "qwen3-coder:30b",
    targetRunnerKind: process.env.RUNTIME_TARGET_RUNNER_KIND || "openai_compatible",
    requireLocalRelay: true,
    requireQwen: true,
    allowGithubWrites: false,
    confirmGithubWrites: "",
    requireAllCommands: true,
    json: false,
    keepWorkItems: false,
    tickTimeoutMs: numberFromEnv("MANAGER_GITHUB_PR_SMOKE_TICK_TIMEOUT_MS", DEFAULT_TICK_TIMEOUT_MS),
    waitTimeoutMs: numberFromEnv("MANAGER_GITHUB_PR_SMOKE_WAIT_TIMEOUT_MS", DEFAULT_WAIT_TIMEOUT_MS),
    supabaseUrl:
      process.env.LAUNCHER_SUPABASE_URL || process.env.SUPABASE_URL || "",
    supabaseKey:
      process.env.LAUNCHER_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--") continue;
    if (arg === "--repo" && next) opts.repos.push(next), i += 1;
    else if (arg === "--pr" && next) opts.prs.push(next), i += 1;
    else if (arg === "--action" && next) opts.action = next, i += 1;
    else if (arg === "--workspace-id" && next) opts.workspaceId = next, i += 1;
    else if (arg === "--agent-id" && next) opts.agentId = next, i += 1;
    else if (arg === "--launcher-url" && next) opts.launcherUrl = next, i += 1;
    else if (arg === "--orchestrator-url" && next) opts.orchestratorUrl = next, i += 1;
    else if (arg === "--supabase-url" && next) opts.supabaseUrl = next, i += 1;
    else if (arg === "--model" && next) opts.model = next, i += 1;
    else if (arg === "--target-runner-kind" && next) opts.targetRunnerKind = next, i += 1;
    else if (arg === "--tick-timeout-ms" && next) opts.tickTimeoutMs = parsePositiveInt(next, "--tick-timeout-ms"), i += 1;
    else if (arg === "--wait-timeout-ms" && next) opts.waitTimeoutMs = parsePositiveInt(next, "--wait-timeout-ms"), i += 1;
    else if (arg === "--allow-github-writes") opts.allowGithubWrites = true;
    else if (arg === "--confirm-github-writes" && next) opts.confirmGithubWrites = next, i += 1;
    else if (arg === "--allow-partial-commands") opts.requireAllCommands = false;
    else if (arg === "--skip-local-relay-check") opts.requireLocalRelay = false;
    else if (arg === "--skip-qwen-check") opts.requireQwen = false;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--keep-work-items") opts.keepWorkItems = true;
    else if (arg === "--help" || arg === "-h") printUsageAndExit();
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  opts.launcherUrl = opts.launcherUrl.replace(/\/+$/, "");
  opts.orchestratorUrl = opts.orchestratorUrl.replace(/\/+$/, "");
  opts.workspaceId = opts.workspaceId.trim();
  opts.agentId = opts.agentId.trim();
  opts.supabaseUrl = opts.supabaseUrl.trim();
  opts.supabaseKey = opts.supabaseKey.trim();
  opts.repos = unique(opts.repos.flatMap(splitCsv).map(normalizeRepo));
  opts.prs = opts.prs.map((value) => parsePrRef(value, opts.repos));
  opts.action = opts.action.trim();
  return opts;
}

function printUsageAndExit() {
  console.log(`Usage: pnpm run smoke:manager-github-pr -- \\
  --workspace-id <workspace-id> \\
  --agent-id <manager-agent-id> \\
  --repo owner/name \\
  --pr owner/name#123

Read-only default:
  Seeds disposable due work that asks the manager to call git.run for:
  gh pr list, gh pr view, and gh pr checks. It fails if a write command appears.

Write modes require all three: --action, --allow-github-writes, and
--confirm-github-writes owner/name#123.

Options:
  --action <mode>                 read-only | review-comment | address-comment | merge
  --repo <owner/name>             Target repo. Repeatable or comma-separated.
  --pr <owner/name#num|num>       Target PR. Repeatable. Bare numbers require one --repo.
  --workspace-id <id>             Workspace whose manager should run.
  --agent-id <id>                 Manager agent id expected to own the work.
  --model <name>                  Local model expected in relay health. Default: qwen3-coder:30b
  --launcher-url <url>            Default: ${DEFAULT_LAUNCHER_URL}
  --orchestrator-url <url>        Default: ${DEFAULT_ORCHESTRATOR_URL}
  --skip-local-relay-check        Do not require helper health before running.
  --skip-qwen-check               Do not require manager status model to contain qwen.
  --allow-partial-commands        Let read-only runs pass after any git.run command with no writes.
  --json                          Print machine-readable JSON.
  --keep-work-items               Leave disposable work items behind for debugging.

Environment:
  MANAGER_WORKSPACE_ID, MANAGER_AGENT_ID, LAUNCHER_URL, ORCHESTRATOR_URL,
  LAUNCHER_SUPABASE_URL or SUPABASE_URL,
  LAUNCHER_SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY`);
  process.exit(0);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  validateOpts(opts);
  const client = supabaseClient(opts);

  await checkGhPreflight(opts);
  await checkLauncherHealth(opts);
  if (opts.requireLocalRelay) await checkLocalRelay(opts);
  const beforeStatus = await waitForManager(opts);

  const workItems = buildWorkItems(opts);
  const created = [];
  let tick = null;
  let finalWorkItems = [];
  let messages = [];
  let assertion = null;

  try {
    for (const item of workItems) {
      created.push(await createWorkItem(client, item, opts));
    }

    tick = await forceManagerTick(opts);
    failOnManagerError(tick);

    finalWorkItems = await Promise.all(created.map((item) => fetchWorkItem(client, item.id)));
    const runIds = runIdsFromTick(tick);
    messages = await fetchRunMessages(client, runIds, opts);
    assertion = assertGithubEvidence({ opts, created, finalWorkItems, tick, messages, beforeStatus });

    printSummary(summaryPayload({ opts, created, finalWorkItems, beforeStatus, tick, messages, assertion }), opts.json);
  } finally {
    if (!opts.keepWorkItems) {
      await Promise.allSettled(created.map((item) => deleteWorkItem(client, item.id)));
    }
  }
}

function validateOpts(opts) {
  if (!opts.workspaceId) throw new Error("workspace id is required. Pass --workspace-id.");
  if (!opts.agentId) throw new Error("manager agent id is required. Pass --agent-id.");
  if (!opts.supabaseUrl) throw new Error("Supabase URL is required. Set SUPABASE_URL or pass --supabase-url.");
  if (!opts.supabaseKey) throw new Error("Supabase service role key is required. Set SUPABASE_SERVICE_ROLE_KEY.");
  if (opts.repos.length === 0) throw new Error("at least one --repo owner/name is required.");

  const allowedActions = new Set(["read-only", "review-comment", "address-comment", "merge"]);
  if (!allowedActions.has(opts.action)) {
    throw new Error(`--action must be one of ${[...allowedActions].join(", ")}`);
  }

  if (opts.action !== "read-only") {
    if (opts.prs.length !== 1) throw new Error(`--action ${opts.action} requires exactly one --pr.`);
    const prRef = prKey(opts.prs[0]);
    if (!opts.allowGithubWrites || opts.confirmGithubWrites !== prRef) {
      throw new Error(
        `GitHub write mode requires --allow-github-writes --confirm-github-writes ${prRef}`,
      );
    }
  }
}

async function checkGhPreflight(opts) {
  await gh(["auth", "status"]);
  for (const repo of opts.repos) {
    await gh(["repo", "view", repo, "--json", "nameWithOwner,url"]);
  }
  for (const pr of opts.prs) {
    await gh(["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "number,title,state,isDraft"]);
  }
  if (!opts.json) {
    console.log(`[manager-github-pr-smoke] gh authenticated; repos=${opts.repos.join(", ")}`);
  }
}

async function gh(args) {
  try {
    return await execFileAsync("gh", args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`gh ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

async function checkLauncherHealth(opts) {
  const health = await fetchJson(`${opts.launcherUrl}/health`);
  if (health.ok !== true) throw new Error(`launcher health is not ok: ${JSON.stringify(health)}`);
  if (health.database && health.database.connected !== true) {
    throw new Error(`launcher database is not connected: ${JSON.stringify(health.database ?? null)}`);
  }
  if (!opts.json) {
    const databaseStatus = health.database?.status ? `; database=${health.database.status}` : "";
    console.log(`[manager-github-pr-smoke] launcher healthy${databaseStatus}`);
  }
}

async function checkLocalRelay(opts) {
  const url = new URL("/api/v1/local-runtime/health", opts.orchestratorUrl);
  url.searchParams.set("workspace_id", opts.workspaceId);
  url.searchParams.set("target_runner_kind", opts.targetRunnerKind);
  if (opts.model) url.searchParams.set("model", opts.model);
  url.searchParams.set("required_capabilities", "runtime_managed_tools");

  const payload = await fetchJson(url.href, {
    headers: serviceRoleHeaders(opts),
  });
  if (payload.ok !== true) {
    throw new Error(`local relay is not ready: ${JSON.stringify(payload)}`);
  }
  if (!opts.json) {
    console.log(`[manager-github-pr-smoke] local relay ready; model=${opts.model || "any"}`);
  }
}

async function waitForManager(opts) {
  const deadline = Date.now() + opts.waitTimeoutMs;
  let lastStatus = null;

  while (Date.now() <= deadline) {
    lastStatus = await managerStatus(opts);
    const error = managerReadinessError(lastStatus, opts);
    if (!error) return lastStatus;
    if (!opts.json) console.log(`[manager-github-pr-smoke] waiting for manager: ${error}`);
    await sleep(1_000);
  }

  throw new Error(`manager did not become ready before timeout. Last status: ${JSON.stringify(lastStatus)}`);
}

async function managerStatus(opts) {
  const url = new URL("/api/runtime/manager-status", opts.launcherUrl);
  url.searchParams.set("workspace_id", opts.workspaceId);
  url.searchParams.set("agent_id", opts.agentId);
  return fetchJson(url.href);
}

function managerReadinessError(status, opts) {
  if (!status || typeof status !== "object") return "empty status";
  if (status.status !== "running") return `status=${status.status}`;
  if (Array.isArray(status.missing) && status.missing.length > 0) return `missing=${status.missing.join(",")}`;
  if (status.last_error) return `last_error=${status.last_error.message || JSON.stringify(status.last_error)}`;
  if (!status.provider) return "provider is missing";
  if (!status.model) return "model is missing";
  if (opts.requireQwen && !String(status.model).toLowerCase().includes("qwen")) {
    return `model is not qwen: ${status.model}`;
  }
  return null;
}

function buildWorkItems(opts) {
  if (opts.action !== "read-only") return [writeWorkItem(opts)];

  const items = [];
  for (const repo of opts.repos) {
    items.push({
      kind: "gh-pr-list",
      repo,
      title: `GitHub PR smoke: list open PRs in ${repo}`,
      description:
        `Read-only smoke. Call git.run once with command exactly: ` +
        `gh pr list --repo ${repo} --state open --limit 5 --json number,title,state,reviewDecision,statusCheckRollup,isDraft. ` +
        `Do not comment, review, merge, push, or modify anything.`,
      expectedCommand: `gh pr list --repo ${repo} --state open`,
    });
  }

  for (const pr of opts.prs) {
    items.push({
      kind: "gh-pr-view",
      repo: pr.repo,
      pr: pr.number,
      title: `GitHub PR smoke: view ${prKey(pr)}`,
      description:
        `Read-only smoke. Call git.run once with command exactly: ` +
        `gh pr view ${pr.number} --repo ${pr.repo} --comments. ` +
        `Do not comment, review, merge, push, or modify anything.`,
      expectedCommand: `gh pr view ${pr.number} --repo ${pr.repo}`,
    });
    items.push({
      kind: "gh-pr-checks",
      repo: pr.repo,
      pr: pr.number,
      title: `GitHub PR smoke: checks ${prKey(pr)}`,
      description:
        `Read-only smoke. Call git.run once with command exactly: ` +
        `gh pr checks ${pr.number} --repo ${pr.repo}. ` +
        `Do not comment, review, merge, push, or modify anything.`,
      expectedCommand: `gh pr checks ${pr.number} --repo ${pr.repo}`,
    });
  }

  return items;
}

function writeWorkItem(opts) {
  const pr = opts.prs[0];
  const commands = {
    "review-comment": `gh pr comment ${pr.number} --repo ${pr.repo} --body "@codex review"`,
    "address-comment": `gh pr comment ${pr.number} --repo ${pr.repo} --body "@codex address that feedback"`,
    merge: `gh pr merge ${pr.number} --repo ${pr.repo} --squash --delete-branch`,
  };
  return {
    kind: `gh-pr-${opts.action}`,
    repo: pr.repo,
    pr: pr.number,
    title: `GitHub PR smoke: ${opts.action} ${prKey(pr)}`,
    description:
      `GitHub write smoke. Call git.run once with command exactly: ${commands[opts.action]}. ` +
      `This run was explicitly confirmed for ${prKey(pr)}. Do not take any other GitHub write action.`,
    expectedCommand: commands[opts.action],
    githubWrite: true,
  };
}

async function createWorkItem(client, item, opts) {
  const now = new Date();
  const id = randomUUID();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const payload = {
    id,
    workspace_id: opts.workspaceId,
    manager_runner_id: opts.agentId,
    identifier: `MGR-GH-PR-${timestamp}-${id.slice(0, 8)}`,
    title: item.title,
    description: item.description,
    state: "running",
    priority: "medium",
    source: "planner",
    labels: ["runtime-smoke", "manager-github-pr"],
    metadata: {
      manager_github_pr_smoke: {
        id,
        kind: item.kind,
        repo: item.repo,
        pr: item.pr || null,
        action: opts.action,
        expected_command: item.expectedCommand,
        github_write: item.githubWrite === true,
        created_at: now.toISOString(),
      },
    },
    next_poll_at: new Date(now.getTime() - 1000).toISOString(),
  };

  const rows = await postgrest(client, "POST", "/work_items", {
    query: { select: SELECT_WORK_ITEM },
    prefer: "return=representation",
    body: payload,
  });
  const created = Array.isArray(rows) ? rows[0] : null;
  if (!created?.id) throw new Error(`work item insert returned no row: ${JSON.stringify(rows)}`);
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
  if (!status || typeof status !== "object") throw new Error("manager status response is empty");
  if (status.status !== "running") throw new Error(`manager is not running: status=${status.status}`);
  if (status.last_error) throw new Error(`manager last_error is present: ${JSON.stringify(status.last_error)}`);
}

async function fetchWorkItem(client, id) {
  const rows = await postgrest(client, "GET", "/work_items", {
    query: { id: `eq.${id}`, select: SELECT_WORK_ITEM, limit: "1" },
  });
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`expected one work_items row for ${id}, got ${JSON.stringify(rows)}`);
  }
  return rows[0];
}

async function fetchRunMessages(client, runIds, opts) {
  if (runIds.length === 0) return [];
  return postgrest(client, "GET", "/message", {
    query: {
      run_id: `in.(${runIds.join(",")})`,
      workspace_id: `eq.${opts.workspaceId}`,
      agent_id: `eq.${opts.agentId}`,
      select: "id,role,created_at,run_id,metadata,tool_call(id,input,output)",
      order: "created_at.desc",
      limit: "50",
    },
  });
}

function assertGithubEvidence({ opts, created, finalWorkItems, tick, messages, beforeStatus }) {
  const tickAt = Date.parse(tick.last_tick_at);
  const beforeTickAt = beforeStatus.last_tick_at ? Date.parse(beforeStatus.last_tick_at) : 0;
  if (!Number.isFinite(tickAt) || tickAt <= beforeTickAt) {
    throw new Error(`manager did not report a fresh tick: ${tick.last_tick_at}`);
  }
  if ((tick.batch?.ok || 0) < created.length) {
    throw new Error(`manager tick did not process every due item: ${JSON.stringify(tick.batch ?? null)}`);
  }

  const toolCalls = messages.flatMap((message) => [
    ...(message.metadata?.tool_calls || []),
    ...(message.tool_call || []),
  ]);
  const gitCommands = gitRunCommands(toolCalls);
  const expectedCommands = created.map((item) => item.metadata?.manager_github_pr_smoke?.expected_command).filter(Boolean);
  const missingCommands = expectedCommands.filter((expected) => !gitCommands.some((command) => command.includes(expected)));
  if (missingCommands.length > 0 && (opts.requireAllCommands || opts.action !== "read-only")) {
    throw new Error(`missing expected git.run commands: ${missingCommands.join(" | ")}; observed=${gitCommands.join(" | ")}`);
  }
  if (opts.action === "read-only" && gitCommands.length === 0) {
    throw new Error(`read-only smoke did not observe any git.run commands`);
  }

  const forbiddenWrites = gitCommands.filter((command) => isForbiddenReadOnlyWrite(command));
  if (opts.action === "read-only" && forbiddenWrites.length > 0) {
    throw new Error(`read-only smoke observed forbidden write commands: ${forbiddenWrites.join(" | ")}`);
  }

  return {
    passed: true,
    expected_commands: expectedCommands,
    missing_expected_commands: missingCommands,
    observed_git_commands: gitCommands,
    tool_calls: toolCalls,
    forbidden_writes: forbiddenWrites,
    database: finalWorkItems.map((item) => ({
      work_item_id: item.id,
      state: item.state,
      next_poll_at: item.next_poll_at,
      updated_at: item.updated_at,
    })),
  };
}

function gitRunCommands(toolCalls) {
  return toolCalls
    .filter((call) => toolName(call) === "git.run")
    .map(commandFromToolCall)
    .filter(Boolean)
    .map(String);
}

function toolName(call) {
  const input = parseMaybeJson(call.input);
  return call.tool || call.name || input?.tool_name || input?.input?.name || null;
}

function commandFromToolCall(call) {
  const input = parseMaybeJson(call.input);
  const output = parseMaybeJson(call.output);
  return (
    call.arguments?.command ||
    call.input?.command ||
    call.command ||
    call.args?.command ||
    input?.input?.arguments?.command ||
    input?.input?.command ||
    output?.output?.output?.command ||
    output?.output?.command ||
    output?.command ||
    null
  );
}

function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function isForbiddenReadOnlyWrite(command) {
  return /\bgh\s+pr\s+(comment|review|merge|edit|close|reopen|ready|lock|unlock)\b/.test(command) ||
    /\bgh\s+issue\s+(comment|create|edit|close|reopen|delete|lock|unlock)\b/.test(command) ||
    /\bgit\s+push\b/.test(command);
}

function runIdsFromTick(tick) {
  return unique((tick?.batch?.results || []).map((result) => result.run_id).filter(Boolean));
}

function summaryPayload({ opts, created, finalWorkItems, beforeStatus, tick, messages, assertion }) {
  return {
    scenarioId: "manager-github-pr-smoke",
    status: "passed",
    action: opts.action,
    workspaceId: opts.workspaceId,
    agentId: opts.agentId,
    repos: opts.repos,
    prs: opts.prs.map(prKey),
    workItemIds: created.map((item) => item.id),
    runIds: runIdsFromTick(tick),
    manager: {
      provider: tick.provider,
      model: tick.model,
      previous_tick_at: beforeStatus.last_tick_at || null,
      last_tick_at: tick.last_tick_at,
      last_decision_count: tick.last_decision_count,
    },
    observedGitCommands: assertion.observed_git_commands,
    expectedCommands: assertion.expected_commands,
    messageIds: messages.map((message) => message.id),
    finalWorkItems,
    nextCommands: [
      `pnpm run logs:runtime -- --since 10m --agent-id ${opts.agentId}`,
      `pnpm run smoke:manager -- --workspace-id ${opts.workspaceId} --agent-id ${opts.agentId}`,
    ],
  };
}

function printSummary(summary, json) {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log("[manager-github-pr-smoke] passed");
  console.log(JSON.stringify(summary, null, 2));
}

async function deleteWorkItem(client, id) {
  await postgrest(client, "DELETE", "/work_items", {
    query: { id: `eq.${id}` },
    prefer: "return=minimal",
  });
}

function supabaseClient(opts) {
  return { endpoint: restEndpoint(opts.supabaseUrl), apiKey: opts.supabaseKey };
}

function restEndpoint(value) {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/rest/v1") ? trimmed : `${trimmed}/rest/v1`;
}

async function postgrest(client, method, pathname, { query = {}, body, prefer } = {}) {
  const url = new URL(`${client.endpoint}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
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
  if (!response.ok) throw new Error(`${init.method || "GET"} ${url} failed with ${response.status}: ${text}`);
  return body;
}

function serviceRoleHeaders(opts) {
  if (!opts.supabaseKey) return {};
  return {
    apikey: opts.supabaseKey,
    authorization: `Bearer ${opts.supabaseKey}`,
  };
}

function parsePrRef(value, repos) {
  const trimmed = String(value || "").trim();
  const hashMatch = trimmed.match(/^([^#]+)#(\d+)$/);
  if (hashMatch) return { repo: normalizeRepo(hashMatch[1]), number: Number.parseInt(hashMatch[2], 10) };
  if (/^\d+$/.test(trimmed) && repos.length === 1) {
    return { repo: repos[0], number: Number.parseInt(trimmed, 10) };
  }
  throw new Error(`invalid --pr ${value}; use owner/name#123, or 123 with exactly one --repo`);
}

function prKey(pr) {
  return `${pr.repo}#${pr.number}`;
}

function normalizeRepo(value) {
  const repo = String(value || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`invalid repo: ${value}`);
  return repo;
}

function splitCsv(value) {
  return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
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

function redactUrl(value) {
  const url = new URL(value);
  for (const key of ["apikey", "Authorization", "authorization"]) {
    if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]");
  }
  return url.href;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  console.error(`[manager-github-pr-smoke] failed: ${error.message}`);
  process.exit(1);
});
