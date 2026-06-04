#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(__dirname, "..");
const defaultBatteryPath = path.join(__dirname, "manager-tool-call-battery.json");

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (args.json) {
    console.log(JSON.stringify({ status: "failed", error: message }, null, 2));
  } else {
    console.error(`manager tool battery failed: ${message}`);
  }
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  loadEnvFile(path.join(platformRoot, ".env"));
  loadEnvFile(path.join(platformRoot, "apps/api/.env"));
  loadEnvFile(path.join(platformRoot, "apps/web/.env"));
  loadEnvFile(path.join(platformRoot, "apps/web/.env.local"));

  const battery = args.suiteSlug ? await loadEvalCatalogBattery(args.suiteSlug) : normalizeBattery(await readJson(args.batteryPath));
  const agentId = args.agentId ?? battery.agentId;
  const workspaceId = args.workspaceId ?? battery.workspaceId;
  const apiBaseUrl = normalizeUrl(args.apiBaseUrl ?? battery.apiBaseUrl ?? "http://127.0.0.1:3100");
  const selectedCases = selectCases(battery);

  requireValue(agentId, "agentId");
  requireValue(workspaceId, "workspaceId");

  if (!args.run) {
    const tools = await loadResolvedTools({ agentId, workspaceId });
    const summary = {
      mode: "dry-run",
      agentId,
      workspaceId,
      apiBaseUrl,
      resolvedTools: tools.map((tool) => ({
        slug: tool.slug,
        name: tool.name,
        executionKind: tool.execution_kind,
        runnerKind: tool.runner_kind,
      })),
      selectedCases: selectedCases.map((testCase) => ({
        id: testCase.id,
        enabled: testCase.enabled !== false,
        expectedToolSlugs: testCase.expectedToolSlugs,
        prohibitedToolSlugs: testCase.prohibitedToolSlugs,
        assertions: testCase.assertions.map((assertion) => ({
          type: assertion.type,
          toolSlug: assertion.toolSlug,
          minCalls: assertion.minCalls,
          maxCalls: assertion.maxCalls,
        })),
      })),
      note: "Pass --run to send prompts. Disabled cases require --include-disabled or --case <id>.",
    };
    printResult(summary);
    return;
  }

  const token = await resolveAccessToken();
  const artifactDir = path.join(
    platformRoot,
    ".run-artifacts",
    "manager-tool-call-battery",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(artifactDir, { recursive: true });
  const evalRun = battery.databaseSuiteId
    ? await createEvalRun({
        suiteId: battery.databaseSuiteId,
        workspaceId,
        agentId,
        selectedCaseIds: selectedCases.map((testCase) => testCase.databaseId).filter(Boolean),
        sideEffectLimit: args.includeDisabled ? "safe_write" : "read_only",
        artifactsPath: artifactDir,
      })
    : null;

  const results = [];
  for (const testCase of selectedCases) {
    results.push(
      await runCase({
        testCase,
        agentId,
        workspaceId,
        apiBaseUrl,
        token,
        artifactDir,
        defaultWaitMs: battery.defaultWaitMs ?? 30_000,
        defaultTimeoutMs: battery.defaultTimeoutMs ?? 90_000,
        evalRunId: evalRun?.id ?? null,
      }),
    );
  }

  const passed = results.every((result) => result.status === "passed");
  const output = {
    status: passed ? "passed" : "failed",
    agentId,
    workspaceId,
    apiBaseUrl,
    artifactDir,
    results,
  };
  await writeJson(path.join(artifactDir, "result.json"), output);
  if (evalRun) {
    const passedCases = results.filter((result) => result.status === "passed").length;
    const failedCases = results.filter((result) => result.status === "failed").length;
    await updateEvalRun(evalRun.id, {
      status: passed ? "passed" : "failed",
      score: passed ? 1 : 0,
      total_cases: results.length,
      passed_cases: passedCases,
      failed_cases: failedCases,
      skipped_cases: 0,
      error_cases: 0,
      summary_text: `Local tool-calling eval ${passed ? "passed" : "failed"}: ${passedCases}/${results.length} cases passed.`,
      completed_at: new Date().toISOString(),
    });
  }
  printResult(output);
  process.exitCode = passed ? 0 : 1;
}

function parseArgs(argv) {
  const parsed = {
    batteryPath: defaultBatteryPath,
    suiteSlug: null,
    agentId: process.env.MANAGER_AGENT_ID ?? process.env.OPENMACAW_MANAGER_AGENT_ID ?? process.env.OPENMACAW_AGENT_ID ?? null,
    workspaceId:
      process.env.MANAGER_WORKSPACE_ID ?? process.env.OPENMACAW_MANAGER_WORKSPACE_ID ?? process.env.OPENMACAW_WORKSPACE_ID ?? null,
    apiBaseUrl: process.env.PLATFORM_API_BASE_URL ?? process.env.OPENMACAW_API_BASE_URL ?? null,
    token: process.env.PLATFORM_API_TOKEN ?? process.env.OPENMACAW_ACCESS_TOKEN ?? null,
    caseIds: [],
    includeDisabled: false,
    run: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    else if (arg === "--suite-slug") parsed.suiteSlug = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--suite-slug=")) parsed.suiteSlug = arg.slice("--suite-slug=".length);
    else if (arg === "--battery") parsed.batteryPath = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--battery=")) parsed.batteryPath = arg.slice("--battery=".length);
    else if (arg === "--agent-id") parsed.agentId = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--agent-id=")) parsed.agentId = arg.slice("--agent-id=".length);
    else if (arg === "--workspace-id") parsed.workspaceId = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--workspace-id=")) parsed.workspaceId = arg.slice("--workspace-id=".length);
    else if (arg === "--api-base-url") parsed.apiBaseUrl = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--api-base-url=")) parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    else if (arg === "--api-token") parsed.token = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--api-token=")) parsed.token = arg.slice("--api-token=".length);
    else if (arg === "--case") parsed.caseIds.push(requireArgValue(arg, argv[++index]));
    else if (arg.startsWith("--case=")) parsed.caseIds.push(arg.slice("--case=".length));
    else if (arg === "--include-disabled") parsed.includeDisabled = true;
    else if (arg === "--run") parsed.run = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  pnpm run smoke:manager-tool-battery
  pnpm run eval:local-tool-calling
  pnpm run eval:local-tool-calling -- --run --case repo-read-file-readme
  pnpm run smoke:manager-tool-battery -- --run --case git-run-gh-repo-view
  pnpm run smoke:manager-tool-battery -- --run --include-disabled --case scheduled-task-create

Options:
  --run                 Actually send prompts. Omit for dry-run discovery.
  --suite-slug <slug>   Load cases from agent_eval_* tables instead of a JSON battery.
  --case <id>           Run/list one case. May be repeated.
  --include-disabled    Include disabled cases when --case is not provided.
  --agent-id <id>       Agent to message. Defaults to MANAGER_AGENT_ID or OPENMACAW_AGENT_ID.
  --workspace-id <id>   Workspace context. Defaults to MANAGER_WORKSPACE_ID or OPENMACAW_WORKSPACE_ID.
  --api-base-url <url>  Platform API URL. Default comes from the suite metadata or battery file.
  --api-token <token>   Bearer token. Otherwise the script signs in using local env login values.
  --json                Print JSON only.
`);
}

function loadEnvFile(filePath) {
  let contents;
  try {
    contents = readFileSyncCompat(filePath);
  } catch {
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (process.env[match[1]] != null) continue;
    process.env[match[1]] = unquote(match[2]);
  }
}

function readFileSyncCompat(filePath) {
  return readFileSync(filePath, "utf8");
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function selectCases(battery) {
  const cases = Array.isArray(battery.cases) ? battery.cases : [];
  if (args.caseIds.length > 0) {
    const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
    return args.caseIds.map((id) => {
      const testCase = byId.get(id);
      if (!testCase) throw new Error(`Unknown case id: ${id}`);
      return testCase;
    });
  }
  return cases.filter((testCase) => args.includeDisabled || testCase.enabled !== false);
}

async function loadResolvedTools({ agentId, workspaceId }) {
  const [agent, grants, globalTools, workspaceTools] = await Promise.all([
    postgrestGet("agent", { select: "id,workspace_id", id: `eq.${agentId}`, limit: "1" }),
    postgrestGet("agent_tool_grant", {
      select: "id,agent_id,workspace_id,tool_id,mode,source",
      agent_id: `eq.${agentId}`,
      workspace_id: `eq.${workspaceId}`,
    }),
    postgrestGet("tool", {
      select: "id,workspace_id,slug,name,description,function_name,execution_kind,runner_kind,enabled",
      workspace_id: "is.null",
    }),
    postgrestGet("tool", {
      select: "id,workspace_id,slug,name,description,function_name,execution_kind,runner_kind,enabled",
      workspace_id: `eq.${workspaceId}`,
    }),
  ]);
  if (agent.length === 0) throw new Error(`Agent not found: ${agentId}`);

  const toolsById = new Map([...globalTools, ...workspaceTools].map((tool) => [tool.id, tool]));
  return grants
    .filter((grant) => grant.mode !== "exclude")
    .map((grant) => toolsById.get(grant.tool_id))
    .filter(Boolean)
    .filter((tool) => tool.enabled !== false)
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

async function runCase(input) {
  const startedAt = new Date();
  const sessionKey = `agent:${input.agentId}:tool-battery:${input.testCase.id}:${randomUUID()}`;
  const message = renderTemplate(input.testCase.prompt, {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    timestamp: startedAt.toISOString().replace(/[:.]/g, "-"),
    futureIso: new Date(startedAt.getTime() + 10 * 60_000).toISOString(),
    scheduledTaskId: process.env.SCHEDULED_TASK_ID ?? "{{scheduledTaskId}}",
    workItemId: process.env.WORK_ITEM_ID ?? "{{workItemId}}",
  });

  const caseDir = path.join(input.artifactDir, input.testCase.id);
  await mkdir(caseDir, { recursive: true });
  await writeJson(path.join(caseDir, "input.json"), {
    id: input.testCase.id,
    prompt: message,
    expectedToolSlugs: input.testCase.expectedToolSlugs,
    sessionKey,
    startedAt: startedAt.toISOString(),
  });

  const gateway = await sendBrowserGatewayMessage({
    apiBaseUrl: input.apiBaseUrl,
    token: input.token,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    sessionKey,
    message,
    timeoutMs: input.testCase.waitMs ?? input.defaultWaitMs,
  });
  await writeJson(path.join(caseDir, "gateway-response.json"), gateway);

  const runtimeFailure =
    gateway.status === "failed"
      ? {
          errorCode: gateway.errorCode ?? null,
          errorMessage: gateway.errorMessage ?? null,
        }
      : null;
  const evidence =
    runtimeFailure == null
      ? await waitForToolEvidence({
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          startedAt,
          expectedToolSlugs: input.testCase.expectedToolSlugs,
          timeoutMs: input.testCase.timeoutMs ?? input.defaultTimeoutMs,
        })
      : await loadToolEvidence({
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          startedAt,
        });
  await writeJson(path.join(caseDir, "evidence.json"), evidence);

  const assertionResults = evaluateAssertions(input.testCase.assertions, evidence);
  const missing = assertionResults
    .filter((result) => result.status === "failed" && result.type !== "no_tool_call")
    .flatMap((result) => (result.toolSlug ? [result.toolSlug] : []));
  const unexpected = assertionResults
    .filter((result) => result.status === "failed" && result.type === "no_tool_call")
    .flatMap((result) => result.observedToolSlugs);
  const passed = assertionResults.every((result) => result.status === "passed");
  const result = {
    id: input.testCase.id,
    status: passed && runtimeFailure == null ? "passed" : "failed",
    expectedToolSlugs: input.testCase.expectedToolSlugs,
    prohibitedToolSlugs: input.testCase.prohibitedToolSlugs,
    observedToolSlugs: evidence.observedToolSlugs,
    missingToolSlugs: missing,
    unexpectedToolSlugs: Array.from(new Set(unexpected)).sort(),
    assertions: assertionResults,
    messageId: null,
    runId: gateway.runId ?? null,
    requestId: gateway.requestId ?? null,
    runtimeFailure,
    artifactDir: caseDir,
  };
  if (input.evalRunId && input.testCase.databaseId) {
    result.evalRunCaseId = await persistEvalRunCase({
      runId: input.evalRunId,
      caseId: input.testCase.databaseId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      status: result.status,
      prompt: message,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      observedToolCallCount: evidence.toolCalls.length,
      assertionResults,
      toolCalls: evidence.toolCalls,
    });
  }
  return result;
}

function normalizeBattery(rawBattery) {
  const rawCases = Array.isArray(rawBattery.cases) ? rawBattery.cases : [];
  const cases = rawCases.map((rawCase, index) => normalizeCase(rawCase, index));
  return {
    ...rawBattery,
    cases,
  };
}

function normalizeCase(rawCase, index) {
  const assertions = normalizeAssertions(rawCase);
  const expectedToolSlugs = Array.from(
    new Set(
      assertions
        .filter((assertion) => assertion.type !== "no_tool_call" && assertion.toolSlug)
        .map((assertion) => assertion.toolSlug),
    ),
  ).sort();
  const prohibitedToolSlugs = Array.from(
    new Set(
      assertions
        .filter((assertion) => assertion.type === "no_tool_call" && assertion.toolSlug)
        .map((assertion) => assertion.toolSlug),
    ),
  ).sort();
  const enabled =
    typeof rawCase.enabled === "boolean"
      ? rawCase.enabled
      : typeof rawCase.enabledByDefault === "boolean"
        ? rawCase.enabledByDefault
        : rawCase.enabled_by_default;

  return {
    ...rawCase,
    id: rawCase.id ?? rawCase.slug ?? `case-${index + 1}`,
    enabled,
    expectedToolSlugs,
    prohibitedToolSlugs,
    assertions,
  };
}

function normalizeAssertions(rawCase) {
  if (Array.isArray(rawCase.assertions) && rawCase.assertions.length > 0) {
    return rawCase.assertions.map((rawAssertion, index) => normalizeAssertion(rawAssertion, index));
  }

  const legacyExpected = Array.isArray(rawCase.expectedToolSlugs) ? rawCase.expectedToolSlugs : [];
  const legacyProhibited = Array.isArray(rawCase.prohibitedToolSlugs) ? rawCase.prohibitedToolSlugs : [];
  return [
    ...legacyExpected.map((slug, index) =>
      normalizeAssertion({ type: "tool_call_observed", toolSlug: slug, minCalls: 1 }, index),
    ),
    ...legacyProhibited.map((slug, index) =>
      normalizeAssertion({ type: "no_tool_call", toolSlug: slug, maxCalls: 0 }, legacyExpected.length + index),
    ),
  ];
}

function normalizeAssertion(rawAssertion, index) {
  const type = rawAssertion.type ?? rawAssertion.assertion_type ?? "tool_call_observed";
  const toolSlug = rawAssertion.toolSlug ?? rawAssertion.tool_slug ?? rawAssertion.tool ?? rawAssertion.tool_name ?? null;
  const minCalls =
    numberOrNull(rawAssertion.minCalls ?? rawAssertion.min_calls) ?? (type === "no_tool_call" ? null : 1);
  const maxCalls = numberOrNull(rawAssertion.maxCalls ?? rawAssertion.max_calls) ?? (type === "no_tool_call" ? 0 : null);
  const argumentHints =
    rawAssertion.argumentHints ??
    rawAssertion.argument_hints ??
    rawAssertion.expectedArgumentHints ??
    rawAssertion.expected_argument_hints ??
    rawAssertion.expected_json?.argumentHints ??
    rawAssertion.expected_json?.argument_hints ??
    [];
  return {
    id: rawAssertion.id ?? `assertion-${index + 1}`,
    type,
    toolSlug,
    minCalls,
    maxCalls,
    argumentHints: Array.isArray(argumentHints) ? argumentHints.map(String) : [],
    required: rawAssertion.required !== false,
  };
}

async function loadEvalCatalogBattery(suiteSlug) {
  const suites = await postgrestGet("agent_eval_suite", {
    select: "id,workspace_id,slug,name,description,suite_type,enabled,tags,metadata",
    slug: `eq.${suiteSlug}`,
    workspace_id: "is.null",
    limit: "1",
  });
  const suite = suites[0];
  if (!suite) throw new Error(`agent eval suite not found: ${suiteSlug}`);

  const cases = await postgrestGet("agent_eval_case", {
    select:
      "id,suite_id,workspace_id,slug,name,prompt,difficulty,side_effect_level,enabled_by_default,timeout_ms,tags,metadata",
    suite_id: `eq.${suite.id}`,
    order: "slug.asc",
  });
  const caseIds = cases.map((testCase) => testCase.id).filter(Boolean);
  const assertions =
    caseIds.length === 0
      ? []
      : await postgrestGet("agent_eval_case_assertion", {
          select:
            "id,case_id,assertion_type,subject_kind,tool_name,tool_slug,tool_call_occurrence,json_path,comparator_mode,expected_text,expected_number,expected_boolean,expected_json,regex,tolerance,min_calls,max_calls,sequence_index,weight,hard_fail,required,ordinal,metadata",
          case_id: `in.(${caseIds.join(",")})`,
          order: "ordinal.asc",
        });
  const assertionsByCaseId = new Map();
  for (const assertion of assertions) {
    const existing = assertionsByCaseId.get(assertion.case_id) ?? [];
    existing.push(assertion);
    assertionsByCaseId.set(assertion.case_id, existing);
  }

  return normalizeBattery({
    id: suite.id,
    databaseSuiteId: suite.id,
    slug: suite.slug,
    name: suite.name,
    description: suite.description,
    suiteType: suite.suite_type,
    enabled: suite.enabled,
    tags: suite.tags ?? [],
    apiBaseUrl: suite.metadata?.apiBaseUrl ?? "http://127.0.0.1:3100",
    defaultTimeoutMs: suite.metadata?.defaultTimeoutMs ?? 90_000,
    defaultWaitMs: suite.metadata?.defaultWaitMs ?? 30_000,
    cases: cases.map((testCase) => ({
      id: testCase.slug,
      databaseId: testCase.id,
      slug: testCase.slug,
      name: testCase.name,
      prompt: testCase.prompt,
      difficulty: testCase.difficulty,
      sideEffectLevel: testCase.side_effect_level,
      enabledByDefault: testCase.enabled_by_default,
      timeoutMs: testCase.timeout_ms,
      tags: testCase.tags ?? [],
      metadata: testCase.metadata ?? {},
      assertions: assertionsByCaseId.get(testCase.id) ?? [],
    })),
  });
}

async function createEvalRun(input) {
  const rows = await postgrestInsert("agent_eval_run", {
    suite_id: input.suiteId,
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    status: "running",
    trigger_source: "manual",
    selected_case_ids: input.selectedCaseIds,
    side_effect_limit: input.sideEffectLimit,
    artifacts_path: input.artifactsPath,
    started_at: new Date().toISOString(),
  });
  return rows[0] ?? null;
}

async function updateEvalRun(runId, patch) {
  await postgrestPatch("agent_eval_run", { id: `eq.${runId}` }, patch);
}

async function persistEvalRunCase(input) {
  const passedAssertions = input.assertionResults.filter((assertion) => assertion.status === "passed").length;
  const failedAssertions = input.assertionResults.filter((assertion) => assertion.status === "failed").length;
  const runCaseRows = await postgrestInsert("agent_eval_run_case", {
    run_id: input.runId,
    case_id: input.caseId,
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    status: input.status,
    prompt: input.prompt,
    score: input.status === "passed" ? 1 : 0,
    passed_assertions: passedAssertions,
    failed_assertions: failedAssertions,
    skipped_assertions: 0,
    observed_tool_call_count: input.observedToolCallCount,
    first_tool_call_id: input.toolCalls[0]?.id ?? null,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    duration_ms: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt)),
  });
  const runCase = runCaseRows[0];
  if (!runCase?.id) return null;

  if (input.assertionResults.length > 0) {
    await postgrestInsert(
      "agent_eval_assertion_result",
      input.assertionResults.map((assertion) => ({
        run_id: input.runId,
        run_case_id: runCase.id,
        assertion_id: isUuid(assertion.id) ? assertion.id : null,
        workspace_id: input.workspaceId,
        assertion_type: assertion.type,
        status: assertion.status,
        score: assertion.status === "passed" ? 1 : 0,
        weight: 1,
        hard_fail: true,
        explanation:
          assertion.status === "passed"
            ? "Expected tool-call assertion was satisfied."
            : "Expected tool-call assertion was not satisfied.",
        expected_text: assertion.toolSlug,
        expected_number: assertion.minCalls ?? assertion.maxCalls,
        actual_number: assertion.observedCallCount,
        expected_json: {
          toolSlug: assertion.toolSlug,
          minCalls: assertion.minCalls,
          maxCalls: assertion.maxCalls,
          argumentHints: assertion.argumentHints,
        },
        actual_json: {
          observedToolSlugs: assertion.observedToolSlugs,
          observedCallCount: assertion.observedCallCount,
        },
      })),
    );
  }

  if (input.toolCalls.length > 0) {
    await postgrestInsert(
      "agent_eval_observation",
      input.toolCalls.map((toolCall, index) => ({
        run_id: input.runId,
        run_case_id: runCase.id,
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        observation_type: "tool_call_observed",
        evidence_kind: "tool_call",
        evidence_table: "tool_call",
        evidence_id: isUuid(toolCall.id) ? toolCall.id : null,
        call_id: toolCall.id ?? null,
        tool_slug: toolCall.toolSlug,
        sequence: index,
        arguments: toolCall.input,
        result: toolCall.output,
        passed: true,
        message_id: isUuid(toolCall.messageId) ? toolCall.messageId : null,
        tool_call_id: isUuid(toolCall.id) ? toolCall.id : null,
      })),
    );
  }

  return runCase.id;
}

function evaluateAssertions(assertions, evidence) {
  return assertions.map((assertion) => {
    const matchingCalls = assertion.toolSlug
      ? evidence.toolCalls.filter((call) => call.toolSlug === assertion.toolSlug)
      : evidence.toolCalls;
    const callCount = matchingCalls.length;
    const observedToolSlugs = Array.from(new Set(matchingCalls.map((call) => call.toolSlug).filter(Boolean))).sort();
    const minPassed = assertion.minCalls == null || callCount >= assertion.minCalls;
    const maxPassed = assertion.maxCalls == null || callCount <= assertion.maxCalls;
    const hintsPassed =
      assertion.argumentHints.length === 0 ||
      matchingCalls.some((call) => {
        const haystack = JSON.stringify({ input: call.input, output: call.output });
        return assertion.argumentHints.every((hint) => haystack.includes(hint));
      });
    const status = minPassed && maxPassed && hintsPassed ? "passed" : "failed";
    return {
      id: assertion.id,
      type: assertion.type,
      toolSlug: assertion.toolSlug,
      status,
      observedCallCount: callCount,
      observedToolSlugs,
      minCalls: assertion.minCalls,
      maxCalls: assertion.maxCalls,
      argumentHints: assertion.argumentHints,
      required: assertion.required,
    };
  });
}

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

async function resolveAccessToken() {
  if (args.token) return args.token;

  const supabaseUrl = requireValue(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_DEV_URL, "SUPABASE_URL");
  const envName = (process.env.VITE_SUPABASE_ENV || "dev").trim();
  const anonKey =
    envName === "prod"
      ? process.env.VITE_SUPABASE_PROD_ANON_KEY || process.env.VITE_SUPABASE_DEV_ANON_KEY
      : process.env.VITE_SUPABASE_DEV_ANON_KEY || process.env.VITE_SUPABASE_PROD_ANON_KEY;
  const email =
    process.env.OPENMACAW_TEST_EMAIL ||
    (envName === "prod" ? process.env.VITE_PROD_LOGIN_EMAIL : process.env.VITE_DEV_LOGIN_EMAIL);
  const password =
    process.env.OPENMACAW_TEST_PASSWORD ||
    (envName === "prod" ? process.env.VITE_PROD_LOGIN_PASSWORD : process.env.VITE_DEV_LOGIN_PASSWORD);

  requireValue(anonKey, "VITE_SUPABASE_DEV_ANON_KEY or --api-token");
  requireValue(email, "VITE_DEV_LOGIN_EMAIL/OPENMACAW_TEST_EMAIL or --api-token");
  requireValue(password, "VITE_DEV_LOGIN_PASSWORD/OPENMACAW_TEST_PASSWORD or --api-token");

  const response = await fetch(`${normalizeUrl(supabaseUrl)}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await parseResponse(response);
  if (!response.ok || !body.access_token) {
    throw new Error(`Supabase sign-in failed (${response.status})`);
  }
  return body.access_token;
}

async function sendBrowserGatewayMessage(input) {
  const startedAt = new Date().toISOString();
  const preparation = sanitizeForArtifact(await prepareRuntime(input));
  const requestId = `battery-${randomUUID()}`;
  const idempotencyKey = `battery-${randomUUID()}`;
  const events = [];

  const ws = await openBrowserGatewaySocket(input, events);
  try {
    const responsePromise = waitForGatewayResponse(ws, requestId, input.timeoutMs, events);
    const eventPromise = waitForGatewayEvent(ws, input.timeoutMs, events);

    ws.send(
      JSON.stringify({
        type: "req",
        id: requestId,
        method: "chat.send",
        params: {
          agent_id: input.agentId,
          workspace_id: input.workspaceId,
          sessionKey: input.sessionKey,
          message: input.message,
          deliver: false,
          idempotencyKey,
        },
      }),
    );

    const response = await responsePromise;
    const runId = response?.runId ?? idempotencyKey;
    const observedEvent = await eventPromise;
    return {
      status: observedEvent?.status ?? "message_accepted",
      requestId,
      runId,
      preparation,
      events,
      startedAt,
      completedAt: new Date().toISOString(),
      errorCode: observedEvent?.errorCode ?? null,
      errorMessage: observedEvent?.errorMessage ?? null,
    };
  } catch (error) {
    return {
      status: "failed",
      requestId,
      runId: idempotencyKey,
      preparation,
      events,
      startedAt,
      completedAt: new Date().toISOString(),
      errorCode: "gateway_message_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    ws.close(1000, "manager tool battery complete");
  }
}

async function prepareRuntime(input) {
  const response = await fetch(`${input.apiBaseUrl}/api/agents/${encodeURIComponent(input.agentId)}/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workspaceId: input.workspaceId }),
  });
  const parsed = await parseResponse(response);
  if (!response.ok) {
    throw new Error(`Runtime prepare failed (${response.status}): ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function openBrowserGatewaySocket(input, events) {
  const url = new URL("/ws", input.apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agent_id", input.agentId);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("session_key", input.sessionKey);

  const ws = new WebSocket(url, ["platform.v1", `bearer.${input.token}`]);
  await waitForSocketOpen(ws, input.timeoutMs);
  await sendBrowserGatewayConnect(ws, input, events);
  return ws;
}

function waitForSocketOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("gateway websocket open timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("gateway websocket failed to connect"));
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`gateway websocket closed before open (${event.code}) ${event.reason}`));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
    ws.addEventListener("close", onClose, { once: true });
  });
}

async function sendBrowserGatewayConnect(ws, input, events) {
  const connectId = `battery-connect-${randomUUID()}`;
  const responsePromise = waitForGatewayHello(ws, connectId, input.timeoutMs, events);
  ws.send(
    JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "openclaw-control-ui",
          version: "app-0.1",
          platform: "node",
          mode: "webchat",
        },
        role: "operator",
        scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
        caps: [],
        auth: { token: input.token },
        userAgent: `node/${process.version}`,
        locale: "en-US",
      },
    }),
  );
  await responsePromise;
}

function waitForGatewayHello(ws, requestId, timeoutMs, events) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("gateway connect timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`gateway closed during connect (${event.code}) ${event.reason}`));
    };
    const onMessage = (event) => {
      const frame = safeJson(String(event.data ?? ""));
      rememberGatewayFrame(events, frame);
      if (frame?.type === "hello-ok") {
        cleanup();
        resolve(frame);
        return;
      }
      if (frame?.type === "res" && frame.id === requestId && frame.ok === false) {
        cleanup();
        reject(new Error(frame.error?.message ?? "gateway connect rejected"));
      }
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

function waitForGatewayResponse(ws, requestId, timeoutMs, events) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("chat.send response timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`gateway closed before chat.send response (${event.code}) ${event.reason}`));
    };
    const onMessage = (event) => {
      const frame = safeJson(String(event.data ?? ""));
      rememberGatewayFrame(events, frame);
      if (frame?.type !== "res" || frame.id !== requestId) return;
      cleanup();
      if (frame.ok === false) {
        reject(new Error(frame.error?.message ?? "chat.send rejected"));
        return;
      }
      resolve(frame.payload ?? {});
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

function waitForGatewayEvent(ws, timeoutMs, events) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ status: "message_accepted", errorCode: null, errorMessage: null });
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    const onClose = () => {
      cleanup();
      resolve({ status: "message_accepted", errorCode: null, errorMessage: null });
    };
    const onMessage = (event) => {
      const frame = safeJson(String(event.data ?? ""));
      rememberGatewayFrame(events, frame);
      if (frame?.type !== "event") return;
      const payload = frame.payload && typeof frame.payload === "object" ? frame.payload : {};
      const errorCode = typeof payload.errorCode === "string" ? payload.errorCode : null;
      const errorMessage = typeof payload.errorMessage === "string" ? payload.errorMessage : null;
      const eventName = typeof frame.event === "string" ? frame.event : null;
      if (errorCode || errorMessage || eventName === "chat.completed" || eventName === "run.completed") {
        cleanup();
        resolve({
          status: errorCode || errorMessage ? "failed" : "completed",
          errorCode,
          errorMessage,
        });
      }
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

function rememberGatewayFrame(events, frame) {
  if (!frame || typeof frame !== "object") return;
  events.push({
    type: typeof frame.type === "string" ? frame.type : null,
    id: typeof frame.id === "string" ? frame.id : null,
    event: typeof frame.event === "string" ? frame.event : null,
    ok: typeof frame.ok === "boolean" ? frame.ok : null,
    payloadKeys:
      frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
        ? Object.keys(frame.payload).sort()
        : [],
    error: frame.error ?? null,
  });
}

function sanitizeForArtifact(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeForArtifact(entry));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (isSensitiveKey(key)) return [key, "[redacted]"];
      return [key, sanitizeForArtifact(entryValue)];
    }),
  );
}

function isSensitiveKey(key) {
  return /(api[_-]?key|token|secret|password|credential|authorization)/i.test(key);
}

async function waitForToolEvidence(input) {
  if (input.expectedToolSlugs.length === 0) {
    await sleep(Math.min(input.timeoutMs, 5_000));
    return loadToolEvidence(input);
  }

  const deadline = Date.now() + input.timeoutMs;
  let latest = { messages: [], observedToolSlugs: [] };

  while (Date.now() < deadline) {
    latest = await loadToolEvidence(input);
    if (input.expectedToolSlugs.every((slug) => latest.observedToolSlugs.includes(slug))) {
      return latest;
    }
    await sleep(2_000);
  }

  return latest;
}

async function loadToolEvidence({ agentId, workspaceId, startedAt }) {
  const rows = await postgrestGet("message", {
    select: "id,role,created_at,run_id,content,tool_call(id,tool_id,input,output,created_at)",
    agent_id: `eq.${agentId}`,
    workspace_id: `eq.${workspaceId}`,
    deleted_at: "is.null",
    created_at: `gte.${startedAt.toISOString()}`,
    order: "created_at.desc",
    limit: "30",
  });

  const toolCalls = rows.flatMap((message) =>
    Array.isArray(message.tool_call)
      ? message.tool_call.map((toolCall) => ({
          id: toolCall.id,
          messageId: message.id,
          runId: message.run_id,
          createdAt: toolCall.created_at,
          toolSlug: toolSlugFromCall(toolCall),
          input: safeJson(toolCall.input),
          output: safeJson(toolCall.output),
        }))
      : [],
  );
  const observedToolSlugs = Array.from(new Set(toolCalls.map((call) => call.toolSlug).filter(Boolean))).sort();

  return {
    observedToolSlugs,
    toolCalls,
    messages: rows.map((message) => ({
      id: message.id,
      role: message.role,
      createdAt: message.created_at,
      runId: message.run_id,
      contentPreview: typeof message.content === "string" ? message.content.slice(0, 500) : "",
    })),
  };
}

function toolSlugFromCall(toolCall) {
  const input = safeJson(toolCall.input);
  const output = safeJson(toolCall.output);
  return (
    input?.tool_name ||
    input?.tool_slug ||
    input?.input?.name ||
    output?.output?.tool_name ||
    output?.output?.tool_slug ||
    null
  );
}

async function postgrestGet(table, params) {
  const supabaseUrl = requireValue(process.env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = requireValue(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  const url = new URL(`${normalizeUrl(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const body = await parseResponse(response);
  if (!response.ok) throw new Error(`PostgREST ${table} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function postgrestInsert(table, value) {
  const supabaseUrl = requireValue(process.env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = requireValue(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${normalizeUrl(supabaseUrl)}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: JSON.stringify(value),
  });
  const body = await parseResponse(response);
  if (!response.ok) throw new Error(`PostGREST ${table} insert failed (${response.status}): ${JSON.stringify(body)}`);
  return Array.isArray(body) ? body : [];
}

async function postgrestPatch(table, params, value) {
  const supabaseUrl = requireValue(process.env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = requireValue(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  const url = new URL(`${normalizeUrl(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, paramValue] of Object.entries(params)) {
    url.searchParams.set(key, paramValue);
  }
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  });
  const body = await parseResponse(response);
  if (!response.ok) throw new Error(`PostGREST ${table} patch failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function renderTemplate(value, context) {
  return String(value).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => context[key] ?? _match);
}

function safeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeUrl(url) {
  return String(url).replace(/\/$/, "");
}

function requireValue(value, name) {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${name} is required`);
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function requireArgValue(flag, value) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printResult(result) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.mode === "dry-run") {
    console.log("manager tool battery dry-run");
    console.log(`agent: ${result.agentId}`);
    console.log(`workspace: ${result.workspaceId}`);
    console.log(`api: ${result.apiBaseUrl}`);
    console.log("");
    console.log("resolved tools:");
    for (const tool of result.resolvedTools) {
      console.log(`  - ${tool.slug} (${tool.executionKind ?? "unknown"}/${tool.runnerKind ?? "unknown"})`);
    }
    console.log("");
    console.log("selected cases:");
    for (const testCase of result.selectedCases) {
      console.log(`  - ${testCase.id}: ${testCase.expectedToolSlugs.join(", ")}`);
    }
    console.log("");
    console.log(result.note);
    return;
  }

  console.log(`manager tool battery ${result.status}`);
  console.log(`artifacts: ${result.artifactDir}`);
  for (const testCase of result.results) {
    const observed = testCase.observedToolSlugs.length > 0 ? testCase.observedToolSlugs.join(", ") : "none";
    console.log(`  ${testCase.status === "passed" ? "PASS" : "FAIL"} ${testCase.id}: observed ${observed}`);
    if (testCase.missingToolSlugs.length > 0) {
      console.log(`       missing ${testCase.missingToolSlugs.join(", ")}`);
    }
    if (testCase.runtimeFailure) {
      const code = testCase.runtimeFailure.errorCode ?? "runtime_failure";
      const message = testCase.runtimeFailure.errorMessage ?? "no message";
      console.log(`       runtime ${code}: ${message}`);
    }
  }
}
