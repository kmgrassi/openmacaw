import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentControlMessageRow } from "../../../../contracts/agent-control.js";
import type { WorkerBridgeSessionRow } from "../../../../contracts/worker-bridge.js";
import type { LauncherClient } from "../services/launcher.js";
import { registerProxyRoutes } from "./proxy.js";

vi.mock("../services/agent-control.js", () => ({
  assertAgentControlAccess: vi.fn(),
  createAgentControlMessage: vi.fn(),
  createAgentRemediation: vi.fn(),
  logAgentRemediationRequested: vi.fn(),
  mapAgentControlMessage: vi.fn((value: unknown) => {
    const row = value as AgentControlMessageRow;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      targetAgentId: row.target_agent_id,
      observerAgentId: row.observer_agent_id,
      kind: row.kind,
      action: row.action,
      subject: row.subject,
      body: row.body,
      metadata: row.metadata,
      status: row.status,
      dispatchStatus: row.dispatch_status,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
    };
  }),
  updateAgentControlMessageDispatchStatus: vi.fn(),
}));

vi.mock("../services/runtime-prepare.js", () => ({
  assertRuntimePrepareSupported: vi.fn(),
}));

const {
  assertAgentControlAccess,
  createAgentControlMessage,
  createAgentRemediation,
  mapAgentControlMessage,
  updateAgentControlMessageDispatchStatus,
} = vi.mocked(await import("../services/agent-control.js"));
const { assertRuntimePrepareSupported } = vi.mocked(await import("../services/runtime-prepare.js"));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const targetAgentId = "33333333-3333-4333-8333-333333333333";
const observerAgentId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function controlRow(overrides: Partial<AgentControlMessageRow> = {}): AgentControlMessageRow {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    workspace_id: workspaceId,
    target_agent_id: targetAgentId,
    observer_agent_id: observerAgentId,
    kind: "handoff",
    action: null,
    subject: "handoff",
    body: "continue this work",
    metadata: {},
    status: "queued",
    dispatch_status: null,
    created_by_user_id: userId,
    created_at: "2026-04-26T09:00:00.000Z",
    ...overrides,
  } as const;
}

function workerBridgeSessionRow(overrides: Partial<WorkerBridgeSessionRow> = {}): WorkerBridgeSessionRow {
  return {
    id: "session-1",
    kind: "codex",
    command: "codex",
    cwd: "/tmp/work",
    status: "running",
    started_at: "2026-04-26T09:00:00.000Z",
    stopped_at: null,
    exit_status: null,
    env_keys: ["NODE_ENV"],
    credential_keys: ["OPENAI_API_KEY"],
    agent_id: targetAgentId,
    workspace_id: workspaceId,
    credential_id: "credential-1",
    ...overrides,
  };
}

describe("agent control routes", () => {
  let server: Server | undefined;
  let baseUrl = "";
  const launcherClient = {
    startAgent: vi.fn(),
  } as unknown as LauncherClient;

  beforeEach(async () => {
    vi.resetAllMocks();
    assertAgentControlAccess.mockResolvedValue(undefined);
    mapAgentControlMessage.mockImplementation((value: unknown) => {
      const row = value as AgentControlMessageRow;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        targetAgentId: row.target_agent_id,
        observerAgentId: row.observer_agent_id,
        kind: row.kind,
        action: row.action,
        subject: row.subject,
        body: row.body,
        metadata: row.metadata,
        status: row.status,
        dispatchStatus: row.dispatch_status,
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at,
      };
    });
    updateAgentControlMessageDispatchStatus.mockResolvedValue(null);
    assertRuntimePrepareSupported.mockResolvedValue({
      agentId: targetAgentId,
      agentType: "coding",
      workspaceId,
      localRuntime: false,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = userId;
      next();
    });
    registerProxyRoutes(app, launcherClient, vi.fn(), 500);

    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("creates structured agent-to-agent messages before the proxy wildcard", async () => {
    createAgentControlMessage.mockResolvedValue(controlRow());

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        observerAgentId,
        body: "continue this work",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      message: {
        targetAgentId,
        observerAgentId,
        body: "continue this work",
      },
    });
    expect(createAgentControlMessage).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId, observerAgentId }));
  });

  it("queues non-restart remediation requests without launcher dispatch", async () => {
    createAgentRemediation.mockResolvedValue(controlRow({ kind: "control", action: "request_credentials" }));

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/remediations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        observerAgentId,
        action: "request_credentials",
        reason: "missing provider key",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      dispatch: {
        attempted: false,
        status: "queued",
      },
      remediation: {
        action: "request_credentials",
      },
    });
    expect(launcherClient.startAgent).not.toHaveBeenCalled();
  });

  it("keeps restart dispatch successful when status persistence fails after launcher start", async () => {
    createAgentRemediation.mockResolvedValue(controlRow({ kind: "control", action: "restart" }));
    updateAgentControlMessageDispatchStatus.mockRejectedValue(new Error("supabase unavailable"));
    launcherClient.startAgent = vi.fn().mockResolvedValue({
      status: 202,
      data: {
        data: {
          id: "orch-1",
          port: 4101,
          config: {},
          started_at: "2026-04-26T09:00:00.000Z",
          status: "running",
          reused: false,
          agent_id: targetAgentId,
          workspace_id: workspaceId,
        },
      },
    });

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/remediations`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        observerAgentId,
        action: "restart",
        reason: "stuck runtime",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      dispatch: {
        attempted: true,
        status: "dispatched_status_update_failed",
      },
      remediation: {
        action: "restart",
        status: "accepted",
        dispatchStatus: "dispatched",
      },
    });
  });

  it("maps worker bridge session rows to camelCase responses", async () => {
    launcherClient.listWorkerBridgeSessions = vi.fn().mockResolvedValue({
      data: [workerBridgeSessionRow()],
    });

    const response = await fetch(`${baseUrl}/api/worker-bridge/sessions`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [
        {
          id: "session-1",
          startedAt: "2026-04-26T09:00:00.000Z",
          stoppedAt: null,
          exitStatus: null,
          envKeys: ["NODE_ENV"],
          credentialKeys: ["OPENAI_API_KEY"],
          agentId: targetAgentId,
          workspaceId,
          credentialId: "credential-1",
        },
      ],
    });
  });
});
