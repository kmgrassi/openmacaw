import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TRANSCRIPT_SCHEMA = "runtime.agent_transcript.v1";

const SECRET_KEY_PATTERN = /(authorization|apikey|api_key|token|secret|password|session[_-]?key|bearer)/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TranscriptRecorder {
  constructor(path, metadata = {}) {
    this.path = path || "";
    this.index = 0;

    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, "", "utf8");
      this.record("transcript.start", { metadata });
    }
  }

  get enabled() {
    return Boolean(this.path);
  }

  record(kind, summary = {}) {
    if (!this.path) return;

    const event = {
      schema: TRANSCRIPT_SCHEMA,
      index: this.index,
      recorded_at: new Date().toISOString(),
      kind,
      summary: redact(summary),
    };

    this.index += 1;
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }

  close(finalSummary = {}) {
    if (!this.path) return;

    this.record("transcript.end", { final: finalSummary });
    this.path = "";
  }
}

export function loadTranscript(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineIndex }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const parseError = new Error(`invalid JSON at line ${lineIndex + 1}: ${error.message}`);
        parseError.eventIndex = lineIndex;
        throw parseError;
      }
    });
}

export function redact(value) {
  return redactValue(value, []);
}

export function summarizeGatewayRequest({ id, method, params }) {
  return {
    request_id: id || null,
    method: method || null,
    params: summarizeParams(method, params || {}),
  };
}

export function summarizeGatewayFrame(frame) {
  if (!frame || typeof frame !== "object") {
    return { frame_type: typeof frame };
  }

  if (frame.type === "res") {
    return {
      frame_type: "res",
      request_id: frame.id || null,
      ok: frame.ok === true,
      error: summarizeError(frame.error),
      payload: summarizePayload(frame.payload),
    };
  }

  if (frame.type === "event") {
    return {
      frame_type: "event",
      event: frame.event || null,
      payload: summarizeEventPayload(frame.payload),
    };
  }

  if (frame.type === "hello-ok") {
    return {
      frame_type: "hello-ok",
      protocol: frame.protocol || null,
      conn_id: frame.server?.connId || null,
      methods: Array.isArray(frame.features?.methods) ? frame.features.methods : [],
    };
  }

  if (frame.type === "socket.close" || frame.type === "socket.error") {
    return frame;
  }

  return {
    frame_type: frame.type || "unknown",
    keys: Object.keys(frame).sort(),
  };
}

export function summarizeHttpExchange({ method = "GET", url, ok, status, body, error }) {
  return {
    method,
    url: redactUrl(url),
    ok: ok === true,
    status: status ?? null,
    error: error || null,
    body: summarizePayload(body),
  };
}

function redactValue(value, path) {
  if (value == null) return value;

  const key = path[path.length - 1] || "";
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";

  if (typeof value === "string") {
    if (SECRET_KEY_PATTERN.test(value)) return "[REDACTED]";
    if (value.includes(":") && value.split(":").every((part) => UUID_PATTERN.test(part))) return "[REDACTED_SESSION_KEY]";
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => redactValue(entry, [...path, String(index)]));
  }

  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, [...path, entryKey])]));
  }

  return value;
}

function summarizeParams(method, params) {
  if (method === "chat.send") {
    return {
      agent_id: params.agent_id || null,
      workspace_id: params.workspace_id || null,
      session_key_present: Boolean(params.sessionKey),
      message_present: typeof params.message === "string" && params.message.length > 0,
      message_length: typeof params.message === "string" ? params.message.length : 0,
      deliver: params.deliver === true,
      idempotency_key: params.idempotencyKey || null,
    };
  }

  if (method === "sessions.list") {
    return { limit: params.limit ?? null };
  }

  return Object.fromEntries(Object.keys(params).sort().map((key) => [key, summarizeScalar(params[key])]));
}

function summarizePayload(payload) {
  if (payload == null) return null;
  if (Array.isArray(payload)) return { type: "array", count: payload.length };
  if (typeof payload !== "object") return summarizeScalar(payload);

  return {
    keys: Object.keys(payload).sort(),
    run_id: payload.runId || payload.run_id || null,
    message_id: payload.messageId || payload.message_id || null,
    count: payload.count ?? null,
    status: payload.status || null,
    state: payload.state || null,
    error_code: payload.errorCode || payload.error_code || null,
    models_count: Array.isArray(payload.models) ? payload.models.length : null,
    helpers_count: Array.isArray(payload.helpers) ? payload.helpers.length : null,
  };
}

function summarizeEventPayload(payload) {
  if (!payload || typeof payload !== "object") return summarizePayload(payload);

  return {
    state: payload.state || null,
    run_id: payload.runId || payload.run_id || null,
    message_id: payload.messageId || payload.message_id || null,
    error_code: payload.errorCode || payload.error_code || null,
    error_category: payload.errorCategory || payload.error_category || null,
    delta_length: typeof payload.delta === "string" ? payload.delta.length : null,
    tool_call_id: payload.toolCallId || payload.tool_call_id || null,
    tool_name: payload.toolName || payload.tool_name || payload.name || null,
  };
}

function summarizeError(error) {
  if (!error || typeof error !== "object") return error || null;
  return {
    code: error.code || null,
    category: error.category || null,
    message: error.message || null,
  };
}

function summarizeScalar(value) {
  if (value == null) return value;
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (typeof value === "object") return { type: "object", keys: Object.keys(value).sort() };
  return { type: typeof value };
}

function redactUrl(rawUrl) {
  if (!rawUrl) return rawUrl;

  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_PATTERN.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
