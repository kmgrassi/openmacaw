#!/usr/bin/env node

import { loadTranscript, TRANSCRIPT_SCHEMA } from "./agent-transcript.mjs";

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const events = loadTranscript(opts.transcript);
  const result = replay(events, opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  process.exit(result.ok ? 0 : 1);
}

export function replay(events, opts = {}) {
  const failures = [];
  const stats = {
    events: events.length,
    gateway_requests: 0,
    gateway_responses: 0,
    gateway_chat_events: 0,
    relay_health_responses: 0,
    terminal_events: 0,
    tool_call_starts: 0,
    tool_call_completions: 0,
  };
  const requestIds = new Set();
  const responseIds = new Set();
  const chatRuns = new Map();
  const openToolCalls = new Map();

  events.forEach((event, position) => {
    const index = Number.isInteger(event.index) ? event.index : position;
    const summary = event.summary || {};

    if (event.schema !== TRANSCRIPT_SCHEMA) {
      failures.push(failure(index, "schema", `expected schema ${TRANSCRIPT_SCHEMA}`));
    }

    if (index !== position) {
      failures.push(failure(index, "index", `expected event index ${position}`));
    }

    if (!event.kind || typeof event.kind !== "string") {
      failures.push(failure(index, "schema", "event kind is required"));
    }

    if (event.kind === "gateway.request.sent") {
      stats.gateway_requests += 1;
      const requestId = summary.request_id;
      if (!requestId) failures.push(failure(index, "gateway.request", "request_id is required"));
      else requestIds.add(requestId);
    }

    if (event.kind === "gateway.frame.received" && summary.frame_type === "res") {
      stats.gateway_responses += 1;
      const requestId = summary.request_id;
      if (!requestId) {
        failures.push(failure(index, "gateway.response", "response request_id is required"));
      } else {
        responseIds.add(requestId);
        if (!requestIds.has(requestId)) {
          failures.push(failure(index, "gateway.response", `response has no prior request: ${requestId}`));
        }
      }

      if (summary.ok !== true) {
        failures.push(failure(index, "gateway.response", errorText(summary.error) || "gateway response failed"));
      }

      if (summary.payload?.run_id) {
        chatRuns.set(summary.payload.run_id, { response_index: index, terminal_index: null, terminal_state: null });
      }
    }

    if (event.kind === "gateway.frame.received" && summary.frame_type === "event" && summary.event === "chat") {
      stats.gateway_chat_events += 1;
      const payload = summary.payload || {};
      const state = payload.state;
      const runId = payload.run_id || "__unknown_run__";
      const record = chatRuns.get(runId) || { response_index: null, terminal_index: null, terminal_state: null };

      if (["final", "error", "aborted"].includes(state)) {
        stats.terminal_events += 1;
        record.terminal_index = index;
        record.terminal_state = state;
        if (state !== "final") {
          failures.push(failure(index, "gateway.chat_terminal", `terminal chat state was ${state}`));
        }
      }

      chatRuns.set(runId, record);
    }

    if (event.kind === "relay.health.response") {
      stats.relay_health_responses += 1;
      if (summary.ok !== true || summary.body?.status === "not_ready") {
        failures.push(failure(index, "relay.health", summary.error || `relay status ${summary.body?.status || "unknown"}`));
      }
    }

    const toolCall = toolCallSummary(event);
    if (toolCall.id && toolCall.phase === "start") {
      stats.tool_call_starts += 1;
      openToolCalls.set(toolCall.id, index);
    } else if (toolCall.id && toolCall.phase === "complete") {
      stats.tool_call_completions += 1;
      if (!openToolCalls.has(toolCall.id)) {
        failures.push(failure(index, "tool_call", `tool completion has no prior start: ${toolCall.id}`));
      } else {
        openToolCalls.delete(toolCall.id);
      }
    }
  });

  for (const requestId of requestIds) {
    if (!responseIds.has(requestId) && opts.requireAllResponses) {
      failures.push(failure(null, "gateway.response", `request has no response: ${requestId}`));
    }
  }

  for (const [runId, record] of chatRuns.entries()) {
    if (record.response_index != null && record.terminal_index == null) {
      failures.push(failure(record.response_index, "gateway.chat_terminal", `run has no terminal chat event: ${runId}`));
    }
  }

  for (const [toolCallId, startIndex] of openToolCalls.entries()) {
    failures.push(failure(startIndex, "tool_call", `tool call has no completion: ${toolCallId}`));
  }

  return {
    ok: failures.length === 0,
    transcript_schema: TRANSCRIPT_SCHEMA,
    stats,
    first_failure: failures[0] || null,
    failures,
  };
}

function parseArgs(argv) {
  const opts = {
    transcript: "",
    json: false,
    requireAllResponses: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") continue;
    if (arg === "--transcript" && next) opts.transcript = next, index += 1;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--require-all-responses") opts.requireAllResponses = true;
    else if (arg === "--help" || arg === "-h") printUsageAndExit();
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  if (!opts.transcript) {
    throw new Error("transcript path is required. Pass --transcript <path>.");
  }

  return opts;
}

function toolCallSummary(event) {
  const summary = event.summary || {};
  const payload = summary.payload || {};
  const toolCallId = summary.tool_call_id || payload.tool_call_id;
  const kind = event.kind || "";
  const state = payload.state || summary.state || "";

  if (!toolCallId) return { id: null, phase: null };
  if (/tool.*(start|request)/i.test(kind) || /tool.*(start|request)/i.test(state)) return { id: toolCallId, phase: "start" };
  if (/tool.*(complete|result|finish)/i.test(kind) || /tool.*(complete|result|finish)/i.test(state)) return { id: toolCallId, phase: "complete" };
  return { id: null, phase: null };
}

function failure(eventIndex, category, message) {
  return { event_index: eventIndex, category, message };
}

function errorText(error) {
  if (!error) return null;
  if (typeof error === "string") return error;
  return [error.category, error.code, error.message].filter(Boolean).join(": ") || null;
}

function printSummary(result) {
  console.log(`[agent-replay] ${result.ok ? "passed" : "failed"}`);
  console.log(`[agent-replay] events=${result.stats.events} gateway_requests=${result.stats.gateway_requests} gateway_responses=${result.stats.gateway_responses} terminal_events=${result.stats.terminal_events}`);

  if (result.first_failure) {
    const index = result.first_failure.event_index == null ? "unknown" : result.first_failure.event_index;
    console.log(`[agent-replay] first failure at event ${index}: ${result.first_failure.category}: ${result.first_failure.message}`);
  }
}

function printUsageAndExit() {
  console.log(`Usage: pnpm run agent:replay -- --transcript <path> [options]

Options:
  --transcript <path>       Redacted JSONL transcript to replay.
  --json                    Print machine-readable JSON only.
  --require-all-responses   Fail if any gateway request lacks a response.`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
