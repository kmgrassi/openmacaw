import { afterEach, describe, expect, it, vi } from "vitest";

import { logEvent } from "./logger.js";

function mockStdoutWrite() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

type StdoutWriteSpy = ReturnType<typeof mockStdoutWrite>;

describe("logEvent", () => {
  const originalApiLogFormat = process.env.API_LOG_FORMAT;
  let stdoutWrite: StdoutWriteSpy | undefined;

  afterEach(() => {
    if (originalApiLogFormat === undefined) {
      delete process.env.API_LOG_FORMAT;
    } else {
      process.env.API_LOG_FORMAT = originalApiLogFormat;
    }
    stdoutWrite?.mockRestore();
    stdoutWrite = undefined;
  });

  it("keeps JSON output by default", () => {
    delete process.env.API_LOG_FORMAT;
    stdoutWrite = mockStdoutWrite();

    logEvent({ event: "request_completed", method: "GET", route_pattern: "/livez", status_code: 200 });

    const line = String(stdoutWrite.mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(line)).toEqual(
      expect.objectContaining({
        event: "request_completed",
        method: "GET",
        route_pattern: "/livez",
        status_code: 200,
      }),
    );
  });

  it("supports opt-in pretty output for local development", () => {
    process.env.API_LOG_FORMAT = "pretty";
    stdoutWrite = mockStdoutWrite();

    logEvent({
      event: "request_failed",
      level: "warn",
      method: "POST",
      route_pattern: "/api/work-items",
      status_code: 401,
      duration_ms: 12,
      error_code: "auth_required",
    });

    const line = String(stdoutWrite.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("WARN");
    expect(line).toContain("request_failed POST /api/work-items");
    expect(line).toContain("status=401");
    expect(line).toContain("duration_ms=12");
    expect(line).toContain("error_code=auth_required");
  });

  it("redacts secrets without hiding token count metrics", () => {
    delete process.env.API_LOG_FORMAT;
    stdoutWrite = mockStdoutWrite();

    logEvent({
      event: "memory_search",
      access_token: "secret-token",
      private_key: "pem-secret",
      result_token_count: 42,
    });

    const line = String(stdoutWrite.mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(line)).toEqual(
      expect.objectContaining({
        access_token: "[redacted]",
        private_key: "[redacted]",
        result_token_count: 42,
      }),
    );
  });

  it("keeps non-sensitive JWT diagnostic claims visible (jwt_* keys are not redacted)", () => {
    delete process.env.API_LOG_FORMAT;
    stdoutWrite = mockStdoutWrite();

    // authJwt logs these on auth_token_rejected. They must survive redaction —
    // they were originally named token_* and got blanked by SECRET_KEY_PATTERN.
    logEvent({
      event: "auth_token_rejected",
      jwt_alg: "ES256",
      jwt_kid: "test-signing-key-id",
      jwt_iss: "https://example.supabase.co/auth/v1",
      jwt_aud: "authenticated",
    });

    const line = String(stdoutWrite.mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(line)).toEqual(
      expect.objectContaining({
        jwt_alg: "ES256",
        jwt_kid: "test-signing-key-id",
        jwt_iss: "https://example.supabase.co/auth/v1",
        jwt_aud: "authenticated",
      }),
    );
  });
});
