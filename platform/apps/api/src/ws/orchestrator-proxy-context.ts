import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { logEvent } from "../logger.js";
import { contextHeaders, withRequestContext } from "../middleware/request-context.js";
import type { RequestContext } from "../request-context-store.js";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type WebSocketRequestContext = RequestContext & {
  connection_id: string;
};

function generatedId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function incomingHeaderValue(request: IncomingMessage, name: string) {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0]?.trim() : raw?.trim();
  return value && ID_PATTERN.test(value) ? value : null;
}

export function createWebSocketRequestContext(request: IncomingMessage): WebSocketRequestContext {
  return {
    trace_id: incomingHeaderValue(request, "x-trace-id") ?? generatedId("trc"),
    request_id: incomingHeaderValue(request, "x-request-id") ?? generatedId("req"),
    connection_id: generatedId("ws"),
  };
}

export function logWebSocketEvent(context: RequestContext, event: Parameters<typeof logEvent>[0]) {
  withRequestContext(context, () => logEvent(event));
}

export function responseContextHeaders(context: RequestContext) {
  return contextHeaders(context);
}
