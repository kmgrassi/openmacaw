import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { logEvent } from "../logger.js";
import { requestContextStorage, type RequestContext } from "../request-context-store.js";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_BODY_CODE = Symbol("errorBodyCode");

function generatedId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function headerValue(req: Request, name: string) {
  const value = req.header(name)?.trim() || "";
  return ID_PATTERN.test(value) ? value : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstStringValue(value: unknown) {
  if (Array.isArray(value)) {
    return stringValue(value[0]);
  }
  return stringValue(value);
}

function responseErrorCode(res: Response) {
  const localsCode = stringValue(res.locals.errorCode);
  if (localsCode) return localsCode;

  return stringValue((res as Response & { [ERROR_BODY_CODE]?: unknown })[ERROR_BODY_CODE]);
}

function routePattern(req: Request) {
  const routePath = req.route?.path;
  if (typeof routePath !== "string" || routePath.length === 0) return undefined;
  const baseUrl = req.baseUrl && !routePath.startsWith(req.baseUrl) ? req.baseUrl : "";
  return `${baseUrl}${routePath}`;
}

function requestWorkspaceId(req: Request) {
  return (
    firstStringValue(req.params?.workspaceId) ??
    firstStringValue(req.query.workspaceId) ??
    stringValue((req.body as { workspaceId?: unknown } | undefined)?.workspaceId)
  );
}

function requestAgentId(req: Request) {
  return (
    firstStringValue(req.params?.agentId) ??
    firstStringValue(req.query.agentId) ??
    stringValue((req.body as { agentId?: unknown } | undefined)?.agentId)
  );
}

function responseErrorCodeFromBody(body: unknown) {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { error?: unknown; code?: unknown };
  if (record.error && typeof record.error === "object") {
    return stringValue((record.error as { code?: unknown }).code);
  }
  return stringValue(record.code);
}

function captureJsonErrorCode(res: Response) {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const code = responseErrorCodeFromBody(body);
    if (code) {
      (res as Response & { [ERROR_BODY_CODE]?: string })[ERROR_BODY_CODE] = code;
    }
    return originalJson(body);
  }) as Response["json"];
}

export function getRequestContext() {
  return requestContextStorage.getStore();
}

export function withRequestContext<T>(context: RequestContext, callback: () => T): T {
  return requestContextStorage.run(context, callback);
}

export function contextHeaders(context = getRequestContext()): Record<string, string> {
  if (!context) return {};
  return {
    "x-trace-id": context.trace_id,
    "x-request-id": context.request_id,
  };
}

export function createRequestContextMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const context: RequestContext = {
      trace_id: headerValue(req, "x-trace-id") ?? generatedId("trc"),
      request_id: headerValue(req, "x-request-id") ?? generatedId("req"),
    };

    req.traceId = context.trace_id;
    req.requestId = context.request_id;
    res.setHeader("x-trace-id", context.trace_id);
    res.setHeader("x-request-id", context.request_id);

    requestContextStorage.run(context, () => {
      const startedAt = Date.now();
      const method = req.method;
      const path = req.path;
      captureJsonErrorCode(res);

      logEvent({
        event: "request_started",
        method,
        path,
        route_pattern: routePattern(req),
        user_id: req.userId,
        workspace_id: requestWorkspaceId(req),
        agent_id: requestAgentId(req),
      });

      res.on("finish", () => {
        const failed = res.statusCode >= 400;
        logEvent({
          event: failed ? "request_failed" : "request_completed",
          level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
          method,
          path,
          route_pattern: routePattern(req),
          status_code: res.statusCode,
          failure_class: failed ? (res.statusCode >= 500 ? "server_error" : "client_error") : undefined,
          error_code: failed ? responseErrorCode(res) : undefined,
          duration_ms: Date.now() - startedAt,
          user_id: req.userId,
          workspace_id: requestWorkspaceId(req),
          agent_id: requestAgentId(req),
        });
      });

      next();
    });
  };
}
