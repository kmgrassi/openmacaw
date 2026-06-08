import { evidenceText, numberOrNull, safeJson } from "./utils.mjs";

export function selectCases(battery, args) {
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

export function normalizeBattery(rawBattery) {
  const rawCases = Array.isArray(rawBattery.cases) ? rawBattery.cases : [];
  const cases = rawCases.map((rawCase, index) => normalizeCase(rawCase, index));
  return {
    ...rawBattery,
    cases,
  };
}

export function evaluateAssertions(assertions, evidence) {
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
        const haystack = evidenceText({ input: call.input, output: call.output });
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

export async function loadEvalCatalogBattery(suiteSlug, postgrestGet) {
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

export function toolEvidenceFromGatewayEvents(events) {
  const toolCallsByKey = new Map();
  for (const event of events) {
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : null;
    if (!payload) continue;
    const toolSlug = payload.tool_slug || payload.toolSlug || payload.tool_name || payload.toolName;
    if (typeof toolSlug !== "string" || toolSlug.trim() === "") continue;
    const id = typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
    const key = `${toolSlug.trim()}:${id ?? toolCallsByKey.size}`;
    const existing = toolCallsByKey.get(key) ?? {};
    toolCallsByKey.set(key, {
      ...existing,
      id,
      messageId: null,
      runId: typeof payload.runId === "string" ? payload.runId : null,
      createdAt: null,
      toolSlug: toolSlug.trim(),
      input: existing.input ?? safeJson(payload.arguments) ?? {},
      output: {
        success: payload.success ?? existing.output?.success ?? null,
        resultSizeBytes: payload.result_size_bytes ?? existing.output?.resultSizeBytes ?? null,
      },
      evidenceKind: "gateway_event",
    });
  }

  const toolCalls = Array.from(toolCallsByKey.values());
  return {
    observedToolSlugs: Array.from(new Set(toolCalls.map((call) => call.toolSlug))).sort(),
    toolCalls,
    messages: [],
  };
}

export function mergeToolEvidence(left, right) {
  const toolCalls = [...(left.toolCalls ?? []), ...(right.toolCalls ?? [])];
  const observedToolSlugs = Array.from(
    new Set([...(left.observedToolSlugs ?? []), ...(right.observedToolSlugs ?? [])].filter(Boolean)),
  ).sort();

  return {
    observedToolSlugs,
    toolCalls,
    messages: left.messages ?? [],
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
