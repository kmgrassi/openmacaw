import assert from "node:assert/strict";
import { test } from "node:test";

import { redact, summarizeGatewayRequest, TRANSCRIPT_SCHEMA } from "../agent-transcript.mjs";
import { replay } from "../agent-replay.mjs";

test("redacts session keys and secret-like fields", () => {
  const redacted = redact({
    sessionKey:
      "33333333-3333-4333-8333-333333333333:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111",
    Authorization: "Bearer abc123",
    nested: { api_key: "secret" },
    safe: "visible",
  });

  assert.equal(redacted.sessionKey, "[REDACTED]");
  assert.equal(redacted.Authorization, "[REDACTED]");
  assert.equal(redacted.nested.api_key, "[REDACTED]");
  assert.equal(redacted.safe, "visible");
});

test("gateway request summaries omit prompt bodies", () => {
  const summary = summarizeGatewayRequest({
    id: "request-1",
    method: "chat.send",
    params: {
      agent_id: "agent-1",
      workspace_id: "workspace-1",
      sessionKey: "secret",
      message: "This prompt should not be persisted",
      idempotencyKey: "run-1",
      deliver: false,
    },
  });

  assert.equal(summary.params.message_present, true);
  assert.equal(summary.params.message_length, 35);
  assert.equal(Object.hasOwn(summary.params, "message"), false);
});

test("replay passes a valid gateway transcript", () => {
  const events = [
    event(0, "transcript.start", {}),
    event(1, "gateway.request.sent", { request_id: "request-1", method: "chat.send" }),
    event(2, "gateway.frame.received", {
      frame_type: "res",
      request_id: "request-1",
      ok: true,
      payload: { run_id: "run-1" },
    }),
    event(3, "gateway.frame.received", {
      frame_type: "event",
      event: "chat",
      payload: { run_id: "run-1", state: "final" },
    }),
    event(4, "transcript.end", {}),
  ];

  const result = replay(events);

  assert.equal(result.ok, true);
  assert.equal(result.stats.terminal_events, 1);
  assert.equal(result.failures.length, 0);
});

test("replay reports the exact failing event index", () => {
  const events = [
    event(0, "transcript.start", {}),
    event(1, "gateway.request.sent", { request_id: "request-1", method: "chat.send" }),
    event(2, "gateway.frame.received", {
      frame_type: "res",
      request_id: "request-1",
      ok: false,
      error: { code: "bad_request", message: "invalid" },
    }),
  ];

  const result = replay(events);

  assert.equal(result.ok, false);
  assert.equal(result.first_failure.event_index, 2);
  assert.equal(result.first_failure.category, "gateway.response");
});

function event(index, kind, summary) {
  return {
    schema: TRANSCRIPT_SCHEMA,
    index,
    recorded_at: "2026-05-12T00:00:00.000Z",
    kind,
    summary,
  };
}
