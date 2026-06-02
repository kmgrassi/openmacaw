import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSubset,
  normalizeToolEvent,
  parseArgs,
  redactValue,
  validateFixture
} from "../agent-tool-smoke.mjs";

test("parseArgs requires a fixture path and accepts tool smoke options", () => {
  const opts = parseArgs([
    "--workspace-id",
    "workspace-1",
    "--agent-id",
    "agent-1",
    "--tool",
    "task.create",
    "--fixture",
    "fixtures/tool-calls/planner-create-work-item.json",
    "--timeout-ms",
    "12000",
    "--json"
  ]);

  assert.equal(opts.workspaceId, "workspace-1");
  assert.equal(opts.agentId, "agent-1");
  assert.equal(opts.tool, "task.create");
  assert.equal(opts.fixturePath, "fixtures/tool-calls/planner-create-work-item.json");
  assert.equal(opts.timeoutMs, 12000);
  assert.equal(opts.json, true);
});

test("validateFixture rejects missing expected tool names", () => {
  assert.throws(
    () => validateFixture({ prompt: "Call a tool" }, "fixture.json"),
    /expected_tool_name/
  );
});

test("assertSubset accepts nested expected argument subsets", () => {
  assert.doesNotThrow(() => {
    assertSubset(
      { title: "Verify runtime tool smoke", metadata: { source: "planner" } },
      {
        title: "Verify runtime tool smoke",
        plan_id: "plan-1",
        metadata: { source: "planner", extra: true }
      },
      "tool arguments"
    );
  });
});

test("assertSubset reports a precise mismatch path", () => {
  assert.throws(
    () => assertSubset({ metadata: { source: "planner" } }, { metadata: { source: "manual" } }, "tool arguments"),
    /\$\.metadata\.source/
  );
});

test("redactValue removes secret-looking argument and result fields", () => {
  const redacted = redactValue({
    title: "Keep this",
    api_key: "sk-live",
    nested: {
      authorization: "Bearer abc",
      output: "visible"
    }
  });

  assert.deepEqual(redacted, {
    title: "Keep this",
    api_key: "[REDACTED]",
    nested: {
      authorization: "[REDACTED]",
      output: "visible"
    }
  });
});

test("normalizeToolEvent handles planner completed payloads without a started event shape", () => {
  const event = normalizeToolEvent("tool_call_completed", {
    params: {
      tool: "task.create",
      callId: "call-1"
    },
    details: {
      success: true,
      output: "{\"id\":\"work-1\"}"
    }
  });

  assert.equal(event.tool_name, "task.create");
  assert.equal(event.tool_call_id, "call-1");
  assert.equal(event.success, true);
  assert.equal(event.result, "{\"id\":\"work-1\"}");
  assert.equal(event.assertion_payload.success, true);
});
