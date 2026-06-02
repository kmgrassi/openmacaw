const API_PATHS = {
  health: "/health",
  authState: "/api/auth/state",
} as const;

export { API_PATHS };

export function resolveBrokerBase(): string {
  const fromEnv = import.meta.env.VITE_BROKER_BASE?.trim() || "";
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  if (typeof window === "undefined") return "";

  const fromStorage =
    window.localStorage.getItem("openclaw.broker_base")?.trim() || "";
  if (fromStorage) return fromStorage.replace(/\/$/, "");

  if (window.location.hostname === "localhost") return "http://localhost:3100";

  return "";
}

export class BrokerSessionError extends Error {
  status: number;
  reason: string;

  constructor(status: number, reason = "") {
    super(
      reason
        ? `Broker session failed (${status}): ${reason}`
        : `Broker session failed (${status})`,
    );
    this.name = "BrokerSessionError";
    this.status = status;
    this.reason = reason;
  }
}

export function isBrokerSessionInvalid(err: unknown): boolean {
  return (
    err instanceof BrokerSessionError &&
    (err.status === 401 || err.status === 403)
  );
}

export async function parseJsonResponse<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: T }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text || {};
  }
  return { ok: response.ok, status: response.status, body: body as T };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
    .filter((entry) => entry.length > 0);
}

type BrokerProbeResult<T> = { ok: boolean; status: number; body: T };

export async function safeParseJsonResponse<T>(
  url: string,
  init?: RequestInit,
): Promise<BrokerProbeResult<T>> {
  try {
    return await parseJsonResponse<T>(url, init);
  } catch {
    return { ok: false, status: 0, body: {} as T };
  }
}
