import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LauncherClient } from "../services/launcher.js";

vi.mock("../services/dev-agent-trigger-message.js", () => ({
  triggerDevAgentMessage: vi.fn(),
}));

const { triggerDevAgentMessage } = vi.mocked(await import("../services/dev-agent-trigger-message.js"));
const { registerDevAgentTriggerMessageRoutes } = await import("./dev-agent-trigger-message.js");

const agentId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "55555555-5555-4555-8555-555555555555";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("dev agent trigger-message route", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let originalNodeEnv: string | undefined;
  const launcherClient = {
    startAgent: vi.fn(),
  } as unknown as LauncherClient;

  beforeEach(async () => {
    vi.resetAllMocks();
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization")) {
        req.userId = userId;
      }
      next();
    });
    registerDevAgentTriggerMessageRoutes(app, launcherClient);

    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    await closeServer(server);
    server = undefined;
  });

  it("returns a compact smoke result for a successful trigger", async () => {
    triggerDevAgentMessage.mockResolvedValue({
      agentId,
      workspaceId,
      messageId: "message-1",
      requestId: "run-1",
      diagnosticBefore: {
        canChat: true,
        blockers: [],
        runnerKind: "codex",
        provider: "openai",
        model: "gpt-5.2",
        launcherHealthy: true,
      },
      runtimeObservation: {
        status: "message_accepted",
        runId: "run-1",
        event: null,
        errorCode: null,
        errorMessage: null,
      },
      messagesAfter: {
        count: 2,
        latestMessageId: "message-1",
        latestRole: "user",
        latestCreatedAt: "2026-05-12T12:00:00.000Z",
      },
      logSummary: {
        available: false,
        note: "Run pnpm run logs:summary with the returned agentId/requestId for full log correlation.",
      },
    });

    const response = await fetch(`${baseUrl}/api/dev/agents/${agentId}/trigger-message`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        message: "Say pong and use no tools",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      agentId,
      workspaceId,
      messageId: "message-1",
      runtimeObservation: { status: "message_accepted", runId: "run-1" },
    });
    expect(triggerDevAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "token",
        userId,
        agentId,
        workspaceId,
        message: "Say pong and use no tools",
        waitMs: 5_000,
        launcherClient,
      }),
    );
  });

  it("requires auth", async () => {
    const response = await fetch(`${baseUrl}/api/dev/agents/${agentId}/trigger-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        message: "Say pong",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
    expect(triggerDevAgentMessage).not.toHaveBeenCalled();
  });

  it("requires workspaceId", async () => {
    const response = await fetch(`${baseUrl}/api/dev/agents/${agentId}/trigger-message`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "Say pong",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(triggerDevAgentMessage).not.toHaveBeenCalled();
  });

  it("returns diagnostic-blocked failures from the trigger service", async () => {
    triggerDevAgentMessage.mockRejectedValue({
      status: 409,
      code: "diagnostic_blocked",
      message: "Agent diagnostic blocked chat trigger",
      details: { canChat: false, blockers: ["Missing credential"] },
    });

    const response = await fetch(`${baseUrl}/api/dev/agents/${agentId}/trigger-message`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        message: "Say pong",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "diagnostic_blocked",
        details: { canChat: false },
      },
    });
  });
});
