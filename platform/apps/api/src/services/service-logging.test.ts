import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  logEvent: logger,
}));

import { logHandledServiceError, withServiceLogging } from "./service-logging.js";

class UserConfigError extends Error {
  code = "credential_not_found";

  constructor(message = "Credential was not found") {
    super(message);
    this.name = "CredentialResolveError";
  }
}

class OperatorFailure extends Error {
  cause: unknown;
  code = "upstream_unavailable";

  constructor(cause: unknown) {
    super("Upstream failed");
    this.name = "OperatorFailure";
    this.cause = cause;
  }
}

describe("withServiceLogging", () => {
  beforeEach(() => {
    logger.mockClear();
  });

  it("logs start and completion records with sanitized input summaries", async () => {
    const result = await withServiceLogging(
      {
        operation: "test.operation",
        inputSummary: {
          workspace_id: "workspace-1",
          credential_count: 2,
        },
      },
      async () => "ok",
    );

    expect(result).toBe("ok");
    expect(logger).toHaveBeenCalledTimes(2);
    expect(logger.mock.calls[0]?.[0]).toMatchObject({
      event: "service_operation_started",
      operation: "test.operation",
      workspace_id: "workspace-1",
      credential_count: 2,
    });
    expect(logger.mock.calls[1]?.[0]).toMatchObject({
      event: "service_operation_completed",
      operation: "test.operation",
      workspace_id: "workspace-1",
      credential_count: 2,
    });
    expect(logger.mock.calls[1]?.[0]).toHaveProperty("duration_ms");
  });

  it("classifies user-fixable configuration errors and rethrows the original cause chain", async () => {
    const rootCause = new Error("connection refused");
    const error = new OperatorFailure(rootCause);

    await expect(
      withServiceLogging(
        {
          operation: "test.operator_failure",
          inputSummary: { agent_id: "agent-1" },
          classifyError: () => ({
            errorCode: "launcher_unavailable",
            layer: "upstream",
            retryable: true,
            userActionable: false,
          }),
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);

    expect(error.cause).toBe(rootCause);
    expect(logger.mock.calls.at(-1)?.[0]).toMatchObject({
      event: "service_operation_failed",
      level: "error",
      operation: "test.operator_failure",
      agent_id: "agent-1",
      layer: "upstream",
      error_code: "launcher_unavailable",
      retryable: true,
      user_actionable: false,
      handled: false,
      error_name: "OperatorFailure",
      error_message: "Upstream failed",
    });
  });

  it("logs handled errors with the next action when a service falls back", () => {
    const error = new UserConfigError();

    logHandledServiceError({
      operation: "test.fallback",
      inputSummary: { agent_id: "agent-1" },
      error,
      nextAction: "fallback_to_cached_state",
    });

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service_operation_failed",
        level: "warn",
        operation: "test.fallback",
        agent_id: "agent-1",
        layer: "configuration",
        error_code: "credential_not_found",
        retryable: false,
        user_actionable: true,
        handled: true,
        next_action: "fallback_to_cached_state",
      }),
    );
  });
});
