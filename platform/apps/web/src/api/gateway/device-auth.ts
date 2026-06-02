const DEVICE_TOKEN_KEY = "openclaw-device-auth-token-operator";

export function loadDeviceAuthToken(): string | null {
  try {
    const raw = localStorage.getItem(DEVICE_TOKEN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { token?: string };
      return parsed.token ?? null;
    }
  } catch {
    // Ignore storage/parsing failures so auth falls back to handshake retries.
  }
  return null;
}

export function storeDeviceAuthToken(token: string) {
  localStorage.setItem(DEVICE_TOKEN_KEY, JSON.stringify({ token }));
}

let nextId = 0;

export function generateRequestId(): string {
  return `r${++nextId}-${Math.random().toString(36).slice(2, 8)}`;
}
