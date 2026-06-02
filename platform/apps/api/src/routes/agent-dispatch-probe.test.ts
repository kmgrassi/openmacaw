import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentDispatchDryRunResponse,
  AgentDispatchLiveResponse,
} from "../../../../contracts/agent-dispatch-probe.js";
import type { LauncherClient } from "../services/launcher.js";
import { buildAgentDispatchDryRun, runAgentDispatchLive } from "../services/agent-dispatch-probe.js";
import { registerAgentDispatchProbeRoutes } from "./agent-dispatch-probe.js";

vi.mock("../services/agent-dispatch-probe.js", () => ({
  buildAgentDispatchDryRun: vi.fn(),
  runAgentDispatchLive: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function platformPayload() {
  return {
    agentId,
    workspaceId,
    platform: {
      profile: {
        agentId,
        workspaceId,
        role: "coding" as const,
        runnerKind: "local_model_coding",
        provider: "openai_compatible",
        model: "qwen2.5-coder:latest",
        toolProfile: "coding" as const,
        credential: { resolved: true, refType: "credential_id" as const },
        capabilities: {
          streaming: true,
          toolCalls: true,
          workspaceWrite: true,
          structuredOutput: true,
          interrupt: true,
        },
      },
      source: {
        routingRuleId: "44444444-4444-4444-8444-444444444444",
        credentialAlias: null,
        fallbackUsed: false,
        legacyGatewayConfigUsed: false,
      },
      toolDefinitions: [],
      workspacePolicy: { sandbox: "workspace_write" as const, approvalPolicy: "on_request" as const },
      executionTarget: {
        kind: "local_helper" as const,
        workspaceId,
        runnerKind: "local_model_coding" as const,
        machineId: "55555555-5555-4555-8555-555555555555",
        workspaceRootRef: "local_runtime_machine:55555555-5555-4555-8555-555555555555",
      },
    },
    runtimePayload: {
      body: {
        agent_id: agentId,
        workspace_id: workspaceId,
        execution_profile: {
          runnerKind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen2.5-coder:latest",
        },
      },
    },
  };
}

function dryRunResponse(): AgentDispatchDryRunResponse {
  return {
    status: "ready",
    mode: "dryRun",
    resolvedAt: "2026-05-12T12:00:00.000Z",
    ...platformPayload(),
  };
}

function liveResponse(status: "matched" | "mismatch"): AgentDispatchLiveResponse {
  return {
    status,
    mode: "live",
    agentId,
    workspaceId,
    resolvedAt: "2026-05-12T12:00:00.000Z",
    runtimeTarget: {
      id: "runtime-1",
      port: 4100,
      status: "running",
      reused: false,
      agentId,
      workspaceId,
    },
    firstObservedRuntimeState: { id: "runtime-1" },
    platform: platformPayload().platform,
    runtimeReported: {
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model: "qwen2.5-coder:latest",
      toolProfile: "coding",
    },
    comparisons: [
      {
        field: "runnerKind",
        platformValue: "local_model_coding",
        runtimeValue: "local_model_coding",
        matches: status === "matched",
      },
    ],
  };
}

describe("agent dispatch probe routes", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let server: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "development";

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerAgentDispatchProbeRoutes(app, {} as LauncherClient);

    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    await closeServer(server);
  });

  it("returns dry-run dispatch configuration without invoking launcher", async () => {
    vi.mocked(buildAgentDispatchDryRun).mockResolvedValue(dryRunResponse());

    const response = await fetch(`${baseUrl}/api/dev/agents/${agentId}/dispatch/dry-run`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      mode: "dryRun",
      platform: {
        profile: {
          runnerKind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen2.5-coder:latest",
        },
      },
    });
    expect(buildAgentDispatchDryRun).toHaveBeenCalledWith({
      accessToken: "test-token",
      requesterUserId: userId,
      agentId,
      workspaceId,
    });
    expect(runAgentDispatchLive).not.toHaveBeenCalled();
  });

  it("returns 409 when live-run config differs from runtime-reported config", async () => {
    vi.mocked(runAgentDispatchLive).mockResolvedValue(liveResponse("mismatch"));

    const response = await fetch(`${baseUrl}/api/dev/agents/${agentId}/dispatch/live`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId }),
    });

    expect(response.status, await response.clone().text()).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      status: "mismatch",
      mode: "live",
      comparisons: [{ field: "runnerKind", matches: false }],
    });
  });

  it("is unavailable outside development", async () => {
    process.env.NODE_ENV = "production";

    const response = await fetch(`${baseUrl}/api/dev/agents/${agentId}/dispatch/dry-run`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId }),
    });

    expect(response.status).toBe(404);
    expect(buildAgentDispatchDryRun).not.toHaveBeenCalled();
  });
});
