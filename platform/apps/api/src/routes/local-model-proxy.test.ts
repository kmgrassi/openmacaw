import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { registerLocalModelProxyRoutes } from "./local-model-proxy.js";

const serviceMocks = vi.hoisted(() => ({
  resolveExecutionProfile: vi.fn(),
  getLocalChatToolResolutionForAgent: vi.fn(),
  getUserScopedSupabase: vi.fn(() => ({})),
}));

vi.mock("../services/execution-profile-resolver.js", () => ({
  resolveExecutionProfile: serviceMocks.resolveExecutionProfile,
}));

vi.mock("../services/local-chat-agent-tools.js", () => ({
  getLocalChatToolResolutionForAgent: serviceMocks.getLocalChatToolResolutionForAgent,
}));

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: serviceMocks.getUserScopedSupabase,
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function localProfile(runnerKind: "local_runtime" | "local_model_coding"): ExecutionProfileResolution {
  return {
    agent: { agentId, workspaceId, role: "coding" },
    profile: {
      agentId,
      workspaceId,
      role: "coding",
      runnerKind,
      provider: "openai_compatible",
      model: "qwen2.5-coder:latest",
      credentialRef: null,
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: runnerKind === "local_model_coding",
        workspaceWrite: runnerKind === "local_model_coding",
        structuredOutput: runnerKind === "local_model_coding",
        interrupt: runnerKind === "local_model_coding",
      },
    },
    missing: [],
    source: {
      routingRuleId: null,
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  };
}

describe("local model proxy", () => {
  let apiServer: Server | undefined;
  let baseUrl = "";
  let originalFetch: typeof fetch;
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = userId;
      next();
    });
    registerLocalModelProxyRoutes(app);

    apiServer = createServer(app);
    const apiPort = await listen(apiServer);
    baseUrl = `http://127.0.0.1:${apiPort}`;

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(baseUrl)) {
        return originalFetch(input, init);
      }

      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "qwen2.5-coder:latest",
          choices: [{ index: 0, message: { role: "assistant", content: "direct chat ok" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    serviceMocks.resolveExecutionProfile.mockResolvedValue(localProfile("local_runtime"));
    serviceMocks.getLocalChatToolResolutionForAgent.mockResolvedValue({
      tools: [],
      rejectedLocalCodingTools: [],
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await closeServer(apiServer);
  });

  it("rejects local_model_coding tools on the legacy direct local-chat path", async () => {
    serviceMocks.resolveExecutionProfile.mockResolvedValue(localProfile("local_model_coding"));
    serviceMocks.getLocalChatToolResolutionForAgent.mockResolvedValue({
      tools: [],
      rejectedLocalCodingTools: [
        {
          id: "tool-shell",
          slug: "shell.exec",
          name: "Run Shell Command",
          functionName: "shell_exec",
          description: "Run shell commands",
          parameters: { type: "object" },
          executionKind: "shell",
          runnerKind: "local_model_coding",
          enabled: true,
        },
      ],
    });

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/local-chat`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "list files" }] }),
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "local_coding_tools_require_runtime_relay",
      message:
        "Coding Agent local model tools run through runtime relay and a registered local-runtime-helper; use runtime dispatch instead of /local-chat.",
      details: {
        agent_id: agentId,
        workspace_id: workspaceId,
        runner_kind: "local_model_coding",
        tool_slugs: ["shell.exec"],
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps no-tool direct local chat available as a dev harness", async () => {
    serviceMocks.resolveExecutionProfile.mockResolvedValue(localProfile("local_model_coding"));
    serviceMocks.getLocalChatToolResolutionForAgent.mockResolvedValue({
      tools: [],
      rejectedLocalCodingTools: [],
    });

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/local-chat`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices?.[0]?.message?.content).toBe("direct chat ok");

    const upstreamCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return !url.startsWith(baseUrl);
    });
    expect(upstreamCalls).toHaveLength(1);
    expect(String(upstreamCalls[0]?.[0])).toContain("http://localhost:11434/v1/chat/completions");
  });

  it("rejects stored local runtime endpoints outside loopback before fetching them", async () => {
    serviceMocks.resolveExecutionProfile.mockResolvedValue({
      ...localProfile("local_runtime"),
      source: {
        routingRuleId: "rule-unsafe-endpoint",
        credentialAlias: null,
        fallbackUsed: false,
        legacyGatewayConfigUsed: false,
      },
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        routing_rule_match: [
          {
            workspace_id: workspaceId,
            rule_id: "rule-unsafe-endpoint",
            kind: "local_endpoint",
            key: "url",
            value: "http://169.254.169.254/latest/meta-data",
          },
        ],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/local-chat`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "local_runtime_invalid_endpoint",
        message: "endpoint host must be localhost, 127.0.0.1, or ::1",
      },
    });

    const upstreamCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return !url.startsWith(baseUrl);
    });
    expect(upstreamCalls).toHaveLength(0);
  });
});
