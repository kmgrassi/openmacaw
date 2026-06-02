import { requestContextStorage } from "./request-context-store.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN = /(authorization|access[_-]?token|api[_-]?key|private[_-]?key|secret|token|cookie|password)/i;

type EcsMetadata = {
  ecs_task_arn_suffix?: string;
  ecs_task_family?: string;
  ecs_task_revision?: string;
  container_name?: string;
  container_id?: string;
};

export type LogEvent = Record<string, unknown> & {
  event: string;
  level?: LogLevel;
};

let ecsMetadata: EcsMetadata = {};

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function arnSuffix(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.split("/").slice(-1)[0];
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isSecretKey(key: string) {
  if (/(^|_)token_count$/i.test(key)) return false;
  return SECRET_KEY_PATTERN.test(key);
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (isSecretKey(key)) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }

  if (value && typeof value === "object") {
    return redactSecrets(value as Record<string, unknown>);
  }

  return value;
}

export async function loadEcsLogMetadata(fetchFn: typeof fetch = fetch) {
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadataUri) return;

  const [containerResponse, taskResponse] = await Promise.all([
    fetchFn(metadataUri).catch(() => undefined),
    fetchFn(`${metadataUri}/task`).catch(() => undefined),
  ]);

  const container = containerResponse?.ok
    ? ((await containerResponse.json().catch(() => ({}))) as Record<string, unknown>)
    : {};
  const task = taskResponse?.ok ? ((await taskResponse.json().catch(() => ({}))) as Record<string, unknown>) : {};

  ecsMetadata = compactRecord({
    ecs_task_arn_suffix: arnSuffix(task.TaskARN),
    ecs_task_family: stringField(task.Family),
    ecs_task_revision: stringField(task.Revision),
    container_name: stringField(container.Name),
    container_id: stringField(container.DockerId),
  });
}

export function redactSecrets<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(key, entry)]));
}

function isPrettyLogFormat() {
  return process.env.API_LOG_FORMAT === "pretty" || process.env.LOG_FORMAT === "pretty";
}

function formatPrettyLog(payload: Record<string, unknown>) {
  const timestamp = typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString();
  const level = typeof payload.level === "string" ? payload.level.toUpperCase().padEnd(5) : "INFO ";
  const event = typeof payload.event === "string" ? payload.event : "log";
  const method = typeof payload.method === "string" ? ` ${payload.method}` : "";
  const route =
    typeof payload.route_pattern === "string"
      ? ` ${payload.route_pattern}`
      : typeof payload.path === "string"
        ? ` ${payload.path}`
        : "";
  const status = typeof payload.status_code === "number" ? ` status=${payload.status_code}` : "";
  const duration = typeof payload.duration_ms === "number" ? ` duration_ms=${payload.duration_ms}` : "";
  const errorCode = typeof payload.error_code === "string" ? ` error_code=${payload.error_code}` : "";
  const requestId = typeof payload.request_id === "string" ? ` request_id=${payload.request_id}` : "";

  return `${timestamp} ${level} ${event}${method}${route}${status}${duration}${errorCode}${requestId}\n`;
}

export function logEvent(event: LogEvent) {
  const context = requestContextStorage.getStore();
  const level = event.level ?? "info";
  const payload = redactSecrets(
    compactRecord({
      level,
      timestamp: new Date().toISOString(),
      service: process.env.SERVICE_NAME ?? "symphony-express-server",
      environment: process.env.APP_ENV ?? process.env.NODE_ENV,
      deploy_run_id: process.env.DEPLOY_RUN_ID || undefined,
      ...ecsMetadata,
      ...context,
      ...event,
    }),
  );

  process.stdout.write(isPrettyLogFormat() ? formatPrettyLog(payload) : `${JSON.stringify(payload)}\n`);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
