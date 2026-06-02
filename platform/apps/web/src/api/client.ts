import { resolveBrokerBase } from "./broker";
import { brokerFetch } from "./broker-fetch";

export type ApiResponseSchema<T> = {
  parse(value: unknown): T;
};

export type ApiFetchOptions<T> = {
  method?: string;
  body?: unknown;
  schema?: ApiResponseSchema<T>;
  auth?: "none" | "supabase";
  baseUrl?: string;
  headers?: HeadersInit;
  defaultErrorMessage?: string | ((status: number) => string);
};

type ApiErrorBody = {
  error?: unknown;
};

type StructuredApiError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

export class ApiClientError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  body: unknown;

  constructor(input: {
    status: number;
    message: string;
    code?: string;
    details?: unknown;
    body: unknown;
  }) {
    super(input.message);
    this.name = "ApiClientError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.body = input.body;
  }
}

function parseResponseText(text: string): unknown {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asStructuredError(value: unknown): StructuredApiError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as StructuredApiError;
}

function fallbackErrorMessage(
  status: number,
  defaultErrorMessage: ApiFetchOptions<unknown>["defaultErrorMessage"],
): string {
  if (typeof defaultErrorMessage === "function") return defaultErrorMessage(status);
  return defaultErrorMessage ?? `Request failed (${status})`;
}

function errorMessageFromBody(
  body: unknown,
  status: number,
  defaultErrorMessage: ApiFetchOptions<unknown>["defaultErrorMessage"],
): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fallbackErrorMessage(status, defaultErrorMessage);
  }

  const error = (body as ApiErrorBody).error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  const structured = asStructuredError(error);
  if (typeof structured?.message === "string" && structured.message.trim()) {
    return structured.message;
  }

  return fallbackErrorMessage(status, defaultErrorMessage);
}

function errorCodeFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const structured = asStructuredError((body as ApiErrorBody).error);
  return typeof structured?.code === "string" ? structured.code : undefined;
}

function errorDetailsFromBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return asStructuredError((body as ApiErrorBody).error)?.details;
}

export async function apiFetch<T = unknown>(path: string, options: ApiFetchOptions<T> = {}): Promise<T> {
  const {
    method = "GET",
    body,
    schema,
    auth = "supabase",
    baseUrl = resolveBrokerBase(),
    headers,
    defaultErrorMessage,
  } = options;

  const requestHeaders = new Headers(headers);
  if (body !== undefined && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }

  const requestInit: RequestInit = {
    method,
    credentials: "include",
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const response =
    auth === "supabase" ? await brokerFetch(`${baseUrl}${path}`, requestInit) : await fetch(`${baseUrl}${path}`, requestInit);

  const responseBody = parseResponseText(await response.text());

  if (!response.ok) {
    throw new ApiClientError({
      status: response.status,
      message: errorMessageFromBody(responseBody, response.status, defaultErrorMessage),
      code: errorCodeFromBody(responseBody),
      details: errorDetailsFromBody(responseBody),
      body: responseBody,
    });
  }

  return schema ? schema.parse(responseBody) : (responseBody as T);
}
