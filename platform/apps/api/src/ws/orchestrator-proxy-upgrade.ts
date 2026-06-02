export class WebSocketUpgradeError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(init: { statusCode: number; code: string; message: string }) {
    super(init.message);
    this.name = "WebSocketUpgradeError";
    this.statusCode = init.statusCode;
    this.code = init.code;
  }
}

export function sanitizeUrlForLogs(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (url.searchParams.has("access_token")) {
      url.searchParams.set("access_token", "[redacted]");
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

export function writeUpgradeJson(
  socket: {
    write: (chunk: string) => boolean;
    destroy: () => void;
  },
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify(payload);
  const statusText = statusCode === 401 ? "Unauthorized" : statusCode === 503 ? "Service Unavailable" : "Bad Request";
  const extraHeaders = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("");
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      extraHeaders +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
  socket.destroy();
}
