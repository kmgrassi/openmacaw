import type { GatewayEventFrame, SessionKey } from "../api/ws-types";

export type RuntimeEventStatus = "running" | "success" | "error" | "info";

export type RuntimeTimelineEvent = {
  id: string;
  kind:
    | "tool_started"
    | "tool_completed"
    | "tool_failed"
    | "turn_completed"
    | "turn_failed"
    | "usage_updated";
  label: string;
  detail: string | null;
  status: RuntimeEventStatus;
  timestamp: number;
  runId: string | null;
};

export type NormalizedRuntimeEvent = {
  assistantDelta: string | null;
  timelineEvent: RuntimeTimelineEvent | null;
  final: boolean;
  aborted: boolean;
  error: { message: string; code: string | null } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function extractRuntimeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        const record = asRecord(block);
        return stringField(record, "text", "content", "delta") ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }

  const record = asRecord(value);
  if (!record) return "";
  const direct = stringField(record, "text", "delta", "message", "content");
  if (direct) return direct;
  if ("content" in record) return extractRuntimeText(record.content);
  if ("message" in record) return extractRuntimeText(record.message);
  return "";
}

function normalizedEventName(
  frame: GatewayEventFrame,
  payload: Record<string, unknown> | null,
): string {
  const raw =
    stringField(payload, "kind", "event", "type", "phase") ?? frame.event;
  return raw.trim().toLowerCase().replace(/[_-]+/g, ".");
}

function sessionMatches(
  payload: Record<string, unknown> | null,
  sessionKey: SessionKey | string,
): boolean {
  const payloadSession = stringField(payload, "sessionKey", "session_key");
  return !payloadSession || payloadSession === sessionKey;
}

function formatEventLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (first) => first.toUpperCase());
}

function formatUsageDetail(
  payload: Record<string, unknown> | null,
): string | null {
  const usage = asRecord(payload?.usage);
  const input =
    numberField(
      payload,
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
    ) ??
    numberField(
      usage,
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
    );
  const output =
    numberField(
      payload,
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
    ) ??
    numberField(
      usage,
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
    );
  const total =
    numberField(payload, "totalTokens", "total_tokens") ??
    numberField(usage, "totalTokens", "total_tokens");

  const parts = [
    input === null ? null : `${input} input`,
    output === null ? null : `${output} output`,
    total === null ? null : `${total} total`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : null;
}

function toolDetail(payload: Record<string, unknown> | null): string | null {
  const tool = stringField(payload, "toolName", "tool_name", "name", "tool");
  const message = stringField(
    payload,
    "message",
    "summary",
    "errorMessage",
    "error",
  );
  return [tool, message].filter(Boolean).join(" - ") || null;
}

function timelineEvent(
  kind: RuntimeTimelineEvent["kind"],
  payload: Record<string, unknown> | null,
  input: Pick<RuntimeTimelineEvent, "label" | "status"> & {
    detail?: string | null;
  },
): RuntimeTimelineEvent {
  const runId = stringField(payload, "runId", "run_id");
  const eventId =
    stringField(payload, "id", "eventId", "event_id", "callId", "call_id") ??
    crypto.randomUUID();
  return {
    id: `${kind}:${runId ?? "run"}:${eventId}`,
    kind,
    label: input.label,
    detail: input.detail ?? null,
    status: input.status,
    timestamp: Date.now(),
    runId,
  };
}

export function normalizeRuntimeEvent(
  frame: GatewayEventFrame,
  sessionKey: SessionKey | string,
): NormalizedRuntimeEvent | null {
  const payload = asRecord(frame.payload);
  if (!sessionMatches(payload, sessionKey)) return null;

  const eventName = normalizedEventName(frame, payload);
  const state = stringField(payload, "state")?.toLowerCase() ?? null;

  if (frame.event === "chat") {
    if (state === "delta") {
      return {
        assistantDelta: extractRuntimeText(payload?.message),
        timelineEvent: null,
        final: false,
        aborted: false,
        error: null,
      };
    }
    if (state === "final") {
      return {
        assistantDelta: null,
        timelineEvent: timelineEvent("turn_completed", payload, {
          label: "Turn completed",
          status: "success",
        }),
        final: true,
        aborted: false,
        error: null,
      };
    }
    if (state === "aborted") {
      return {
        assistantDelta: null,
        timelineEvent: timelineEvent("turn_failed", payload, {
          label: "Turn aborted",
          detail: stringField(payload, "message", "summary"),
          status: "info",
        }),
        final: false,
        aborted: true,
        error: null,
      };
    }
    if (state === "error") {
      const message =
        stringField(payload, "errorMessage", "message", "error") ??
        "Runtime event failed";
      return {
        assistantDelta: null,
        timelineEvent: timelineEvent("turn_failed", payload, {
          label: "Turn failed",
          detail: message,
          status: "error",
        }),
        final: false,
        aborted: false,
        error: {
          message,
          code: stringField(payload, "errorCode", "error_code"),
        },
      };
    }
  }

  if (
    eventName === "message.delta" ||
    eventName === "assistant.delta" ||
    eventName === "assistant.delta.text"
  ) {
    return {
      assistantDelta: extractRuntimeText(
        payload?.message ?? payload?.delta ?? payload?.content ?? payload?.text,
      ),
      timelineEvent: null,
      final: false,
      aborted: false,
      error: null,
    };
  }

  if (
    eventName === "tool.started" ||
    eventName === "tool.start" ||
    eventName === "tool.call.started"
  ) {
    return {
      assistantDelta: null,
      timelineEvent: timelineEvent("tool_started", payload, {
        label: "Tool started",
        detail: toolDetail(payload),
        status: "running",
      }),
      final: false,
      aborted: false,
      error: null,
    };
  }

  if (
    eventName === "tool.completed" ||
    eventName === "tool.complete" ||
    eventName === "tool.completion" ||
    eventName === "tool.call.completed"
  ) {
    return {
      assistantDelta: null,
      timelineEvent: timelineEvent("tool_completed", payload, {
        label: "Tool completed",
        detail: toolDetail(payload),
        status: "success",
      }),
      final: false,
      aborted: false,
      error: null,
    };
  }

  if (
    eventName === "tool.failed" ||
    eventName === "tool.failure" ||
    eventName === "tool.call.failed"
  ) {
    return {
      assistantDelta: null,
      timelineEvent: timelineEvent("tool_failed", payload, {
        label: "Tool failed",
        detail: toolDetail(payload),
        status: "error",
      }),
      final: false,
      aborted: false,
      error: null,
    };
  }

  if (
    eventName === "turn.completed" ||
    eventName === "turn.completion" ||
    eventName === "run.completed" ||
    eventName === "run.completion"
  ) {
    return {
      assistantDelta: null,
      timelineEvent: timelineEvent("turn_completed", payload, {
        label: eventName.startsWith("run.")
          ? "Run completed"
          : "Turn completed",
        detail: stringField(payload, "message", "summary"),
        status: "success",
      }),
      final: true,
      aborted: false,
      error: null,
    };
  }

  if (
    eventName === "turn.failed" ||
    eventName === "turn.failure" ||
    eventName === "run.failed" ||
    eventName === "run.failure"
  ) {
    const message =
      stringField(payload, "errorMessage", "error", "message") ??
      formatEventLabel(eventName);
    return {
      assistantDelta: null,
      timelineEvent: timelineEvent("turn_failed", payload, {
        label: eventName.startsWith("run.") ? "Run failed" : "Turn failed",
        detail: message,
        status: "error",
      }),
      final: false,
      aborted: false,
      error: { message, code: stringField(payload, "errorCode", "error_code") },
    };
  }

  if (
    eventName === "usage.updated" ||
    eventName === "usage.update" ||
    eventName === "usage"
  ) {
    return {
      assistantDelta: null,
      timelineEvent: timelineEvent("usage_updated", payload, {
        label: "Usage updated",
        detail: formatUsageDetail(payload),
        status: "info",
      }),
      final: false,
      aborted: false,
      error: null,
    };
  }

  return null;
}

export function runtimeEventRunId(
  frame: GatewayEventFrame,
  normalized: NormalizedRuntimeEvent,
): string | null {
  if (normalized.timelineEvent?.runId) return normalized.timelineEvent.runId;
  const payload = asRecord(frame.payload);
  return stringField(payload, "runId", "run_id");
}

export function runtimeEventMatchesActiveRun(
  activeRunId: string | null,
  eventRunId: string | null,
): boolean {
  return !activeRunId || !eventRunId || activeRunId === eventRunId;
}
