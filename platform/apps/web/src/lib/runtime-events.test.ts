import { describe, expect, it, vi } from "vitest";
import type {
  ChatEventPayload,
  GatewayEventFrame,
  RuntimeEventPayload,
  RuntimeGatewayEventName,
} from "../api/ws-types";
import {
  normalizeRuntimeEvent,
  runtimeEventMatchesActiveRun,
  runtimeEventRunId,
} from "./runtime-events";

const sessionKey = "agent:11111111-1111-4111-8111-111111111111:main";

function frame(
  event: "chat" | RuntimeGatewayEventName,
  payload: Record<string, unknown>,
): GatewayEventFrame {
  const fullPayload = {
    sessionKey,
    runId: "run-1",
    ...payload,
  };
  if (event === "chat") {
    return {
      type: "event",
      event,
      payload: fullPayload as ChatEventPayload,
    };
  }
  return {
    type: "event",
    event,
    payload: fullPayload as RuntimeEventPayload,
  };
}

describe("normalizeRuntimeEvent", () => {
  it("extracts assistant deltas from normalized message events", () => {
    const normalized = normalizeRuntimeEvent(
      frame("message.delta", { delta: "hello from claude" }),
      sessionKey,
    );

    expect(normalized?.assistantDelta).toBe("hello from claude");
    expect(normalized?.timelineEvent).toBeNull();
  });

  it("maps normalized tool lifecycle events to timeline entries", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );

    const started = normalizeRuntimeEvent(
      frame("tool_start", { toolName: "Bash", message: "pnpm test" }),
      sessionKey,
    );
    const completed = normalizeRuntimeEvent(
      frame("tool_completion", { tool_name: "Bash", summary: "exit 0" }),
      sessionKey,
    );
    const failed = normalizeRuntimeEvent(
      frame("tool_failure", { name: "Edit", error: "patch failed" }),
      sessionKey,
    );

    expect(started?.timelineEvent).toMatchObject({
      kind: "tool_started",
      label: "Tool started",
      detail: "Bash - pnpm test",
      status: "running",
    });
    expect(completed?.timelineEvent).toMatchObject({
      kind: "tool_completed",
      label: "Tool completed",
      detail: "Bash - exit 0",
      status: "success",
    });
    expect(failed?.timelineEvent).toMatchObject({
      kind: "tool_failed",
      label: "Tool failed",
      detail: "Edit - patch failed",
      status: "error",
    });
  });

  it("maps turn failures and usage updates without provider-specific payloads", () => {
    const failed = normalizeRuntimeEvent(
      frame("turn_failure", {
        errorMessage: "bridge startup failed",
        errorCode: "bridge_failed",
      }),
      sessionKey,
    );
    const usage = normalizeRuntimeEvent(
      frame("usage.updated", {
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      }),
      sessionKey,
    );

    expect(failed?.error).toEqual({
      message: "bridge startup failed",
      code: "bridge_failed",
    });
    expect(failed?.timelineEvent).toMatchObject({
      kind: "turn_failed",
      label: "Turn failed",
      detail: "bridge startup failed",
      status: "error",
    });
    expect(usage?.timelineEvent).toMatchObject({
      kind: "usage_updated",
      label: "Usage updated",
      detail: "12 input / 8 output / 20 total",
      status: "info",
    });
  });

  it("treats chat aborts as cancellation events without surfacing an error", () => {
    const aborted = normalizeRuntimeEvent(
      frame("chat", { state: "aborted", message: "user canceled" }),
      sessionKey,
    );

    expect(aborted).toMatchObject({
      assistantDelta: null,
      final: false,
      aborted: true,
      error: null,
    });
    expect(aborted?.timelineEvent).toMatchObject({
      kind: "turn_failed",
      label: "Turn aborted",
      detail: "user canceled",
      status: "info",
    });
  });

  it("exposes event run IDs for active-run filtering", () => {
    const completed = normalizeRuntimeEvent(
      frame("turn.completed", { runId: "runtime-run-1" }),
      sessionKey,
    );

    expect(completed).not.toBeNull();
    expect(
      runtimeEventRunId(
        frame("turn.completed", { runId: "runtime-run-1" }),
        completed!,
      ),
    ).toBe("runtime-run-1");
    expect(runtimeEventMatchesActiveRun("runtime-run-1", "runtime-run-1")).toBe(
      true,
    );
    expect(runtimeEventMatchesActiveRun("active-run", "other-run")).toBe(false);
    expect(runtimeEventMatchesActiveRun("active-run", null)).toBe(true);
  });
});
