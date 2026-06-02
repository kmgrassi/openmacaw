import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getManagerAgentConfig, updateManagerAgentConfig } from "../services/manager-agent-config.js";
import { getManagerRuntimeStatus } from "../services/manager-runtime-status.js";
import { registerManagerAgentRoutes } from "./manager-agent.js";

vi.mock("../services/manager-runtime-status.js", () => ({
  getManagerRuntimeStatus: vi.fn(),
}));
vi.mock("../services/manager-agent-config.js", () => ({
  getManagerAgentConfig: vi.fn(),
  updateManagerAgentConfig: vi.fn(),
}));
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const managerAgentId = "33333333-3333-4333-8333-333333333333";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("manager agent routes", () => {
  let server: Server;
  let baseUrl = "";
  const runtimeRequest = vi.fn();

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(getManagerRuntimeStatus).mockResolvedValue({
      workspaceId,
      agentId: managerAgentId,
      status: "running",
      lastTickAt: "2026-04-27T12:00:00.000Z",
      lastDecisionCount: 3,
      missing: [],
      error: null,
    });
    vi.mocked(getManagerAgentConfig).mockResolvedValue({
      agentId: managerAgentId,
      cadenceMs: null,
      workspaceCadenceMs: 60000,
      dueTaskQuery: {},
      workspaceDueTaskQuery: {},
      effectiveCadenceMs: 60000,
      effectiveDueTaskQuery: {
        states: ["running", "awaiting_review"],
        planIds: null,
      },
    });
    vi.mocked(updateManagerAgentConfig).mockResolvedValue({
      agentId: managerAgentId,
      cadenceMs: 30000,
      workspaceCadenceMs: 60000,
      dueTaskQuery: {
        states: ["running"],
      },
      workspaceDueTaskQuery: {},
      effectiveCadenceMs: 30000,
      effectiveDueTaskQuery: {
        states: ["running"],
        planIds: null,
      },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerManagerAgentRoutes(app, runtimeRequest);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("requires bearer auth", async () => {
    const response = await fetch(`${baseUrl}/api/runtime/manager-status?workspace_id=${workspaceId}`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });

  it("requires workspace_id", async () => {
    const response = await fetch(`${baseUrl}/api/runtime/manager-status`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("returns manager runtime status for authenticated workspace polling", async () => {
    const response = await fetch(`${baseUrl}/api/runtime/manager-status?workspace_id=${workspaceId}`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      manager: {
        workspaceId,
        agentId: managerAgentId,
        status: "running",
        lastTickAt: "2026-04-27T12:00:00.000Z",
        lastDecisionCount: 3,
        missing: [],
        error: null,
      },
    });
    expect(getManagerRuntimeStatus).toHaveBeenCalledWith({
      workspaceId,
      userId,
      runtimeRequest,
    });
  });

  it("returns per-agent manager config for authenticated workspace requests", async () => {
    const response = await fetch(
      `${baseUrl}/api/agents/${managerAgentId}/scheduler-config?workspaceId=${workspaceId}`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agentId: managerAgentId,
      cadenceMs: null,
      workspaceCadenceMs: 60000,
      dueTaskQuery: {},
      workspaceDueTaskQuery: {},
      effectiveCadenceMs: 60000,
      effectiveDueTaskQuery: {
        states: ["running", "awaiting_review"],
        planIds: null,
      },
    });
    expect(getManagerAgentConfig).toHaveBeenCalledWith({
      accessToken: "test-token",
      workspaceId,
      agentId: managerAgentId,
    });
  });

  it("updates per-agent manager config with a validated request body", async () => {
    const response = await fetch(
      `${baseUrl}/api/agents/${managerAgentId}/scheduler-config?workspaceId=${workspaceId}`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cadenceMs: 30000,
          dueTaskQuery: {
            states: ["running"],
            planIds: null,
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentId: managerAgentId,
      cadenceMs: 30000,
      effectiveCadenceMs: 30000,
      dueTaskQuery: {
        states: ["running"],
      },
    });
    expect(updateManagerAgentConfig).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      workspaceId,
      agentId: managerAgentId,
      request: {
        cadenceMs: 30000,
        dueTaskQuery: {
          states: ["running"],
          planIds: null,
        },
      },
    });
  });

  it("does not register the old manager activation endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/manager-agent/activate`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        agentId: managerAgentId,
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4.5",
        newCredential: {
          apiKey: "sk-ant-test",
        },
      }),
    });

    expect(response.status).toBe(404);
  });
});
