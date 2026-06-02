export type CapturedConsoleError = {
  timestamp: string;
  source: "console.error" | "window.error" | "unhandledrejection";
  message: string;
  stack: string | null;
};

const MAX_CAPTURED_ERRORS = 25;
const SECRET_KEY_PATTERN =
  /(authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|api[_-]?key)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

let capturedErrors: CapturedConsoleError[] = [];
let installed = false;
let originalConsoleError: typeof console.error | null = null;

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(JWT_PATTERN, "[redacted.jwt]");
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY_PATTERN.test(key)
        ? "[redacted]"
        : redactValue(entry, depth + 1),
    ]),
  );
}

function stringifyConsoleArg(value: unknown): string {
  if (value instanceof Error) {
    return redactString(value.message);
  }
  if (typeof value === "string") return redactString(value);
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return redactString(String(value));
  }
}

function stackFrom(value: unknown): string | null {
  if (value instanceof Error && value.stack) {
    return redactString(value.stack);
  }
  return null;
}

function pushCapturedError(error: CapturedConsoleError) {
  capturedErrors = [...capturedErrors, error].slice(-MAX_CAPTURED_ERRORS);
}

function capture(source: CapturedConsoleError["source"], args: unknown[]) {
  const message = args.map(stringifyConsoleArg).filter(Boolean).join(" ");
  pushCapturedError({
    timestamp: new Date().toISOString(),
    source,
    message: message || "Unknown browser error",
    stack: args.map(stackFrom).find((stack) => stack !== null) ?? null,
  });
}

export function installBrowserConsoleErrorCapture(): () => void {
  if (installed) return () => {};

  installed = true;
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    capture("console.error", args);
    originalConsoleError?.(...args);
  };

  const errorHandler = (event: ErrorEvent) => {
    capture("window.error", [event.error ?? event.message]);
  };
  const rejectionHandler = (event: PromiseRejectionEvent) => {
    capture("unhandledrejection", [event.reason]);
  };

  window.addEventListener("error", errorHandler);
  window.addEventListener("unhandledrejection", rejectionHandler);

  return () => {
    if (!installed) return;
    if (originalConsoleError) {
      console.error = originalConsoleError;
    }
    originalConsoleError = null;
    installed = false;
    window.removeEventListener("error", errorHandler);
    window.removeEventListener("unhandledrejection", rejectionHandler);
  };
}

export function getCapturedBrowserConsoleErrors(): CapturedConsoleError[] {
  return [...capturedErrors];
}

export function clearCapturedBrowserConsoleErrors() {
  capturedErrors = [];
}

export const browserConsoleErrorInternalsForTest = {
  capture,
  redactValue,
};
