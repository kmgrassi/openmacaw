import { errorMessage, logEvent, type LogEvent } from "../logger.js";

type ServiceErrorLayer = "api" | "configuration" | "database" | "runtime" | "upstream" | "validation" | "unknown";

type ServiceErrorClassification = {
  errorCode: string;
  layer: ServiceErrorLayer;
  retryable: boolean;
  userActionable: boolean;
};

type ServiceLoggingOptions = {
  operation: string;
  inputSummary?: Record<string, unknown>;
  classifyError?: (error: unknown) => Partial<ServiceErrorClassification>;
};

type HandledServiceErrorOptions = ServiceLoggingOptions & {
  error: unknown;
  nextAction: string;
};

function compactLogEvent(record: LogEvent): LogEvent {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as LogEvent;
}

function stringProperty(error: unknown, key: string) {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberProperty(error: unknown, key: string) {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function booleanProperty(error: unknown, key: string) {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

export function classifyServiceError(error: unknown): ServiceErrorClassification {
  const name = error instanceof Error ? error.name : undefined;
  const status = numberProperty(error, "status") ?? numberProperty(error, "statusCode");
  const code = stringProperty(error, "code");
  const retryable = booleanProperty(error, "retryable") ?? booleanProperty(error, "retriable") ?? false;

  if (code?.startsWith("credential_") || code === "workspace_id_missing") {
    return {
      errorCode: code,
      layer: "configuration",
      retryable: false,
      userActionable: true,
    };
  }

  if (name === "ApiRouteError" && status !== undefined) {
    return {
      errorCode: code ?? `api_${status}`,
      layer: status >= 500 ? "api" : "validation",
      retryable: status >= 500,
      userActionable: status < 500,
    };
  }

  if (name?.startsWith("Launcher")) {
    return {
      errorCode: code ?? name,
      layer: "upstream",
      retryable,
      userActionable: name === "LauncherHttpError" && status !== undefined && status >= 400 && status < 500,
    };
  }

  if (name === "RuntimeTargetError") {
    return {
      errorCode: code ?? "runtime_target_error",
      layer: "runtime",
      retryable,
      userActionable: status === 404,
    };
  }

  return {
    errorCode: code ?? name ?? "unknown_error",
    layer: "unknown",
    retryable,
    userActionable: false,
  };
}

export async function withServiceLogging<T>(options: ServiceLoggingOptions, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const base = {
    operation: options.operation,
    ...(options.inputSummary ?? {}),
  };

  logEvent({
    event: "service_operation_started",
    ...base,
  });

  try {
    const result = await operation();
    logEvent({
      event: "service_operation_completed",
      ...base,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const classification = {
      ...classifyServiceError(error),
      ...(options.classifyError?.(error) ?? {}),
    };

    logEvent(
      compactLogEvent({
        event: "service_operation_failed",
        level: "error",
        ...base,
        duration_ms: Date.now() - startedAt,
        layer: classification.layer,
        error_code: classification.errorCode,
        retryable: classification.retryable,
        user_actionable: classification.userActionable,
        handled: false,
        error_name: error instanceof Error ? error.name : undefined,
        error_message: errorMessage(error),
      }),
    );

    throw error;
  }
}

export function logHandledServiceError(options: HandledServiceErrorOptions) {
  const classification = {
    ...classifyServiceError(options.error),
    ...(options.classifyError?.(options.error) ?? {}),
  };

  logEvent(
    compactLogEvent({
      event: "service_operation_failed",
      level: "warn",
      operation: options.operation,
      ...(options.inputSummary ?? {}),
      layer: classification.layer,
      error_code: classification.errorCode,
      retryable: classification.retryable,
      user_actionable: classification.userActionable,
      handled: true,
      next_action: options.nextAction,
      error_name: options.error instanceof Error ? options.error.name : undefined,
      error_message: errorMessage(options.error),
    }),
  );
}
