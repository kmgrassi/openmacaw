import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { registerLocalRuntimeRoutes } from "./local-runtime.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("local runtime routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerLocalRuntimeRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("assigns a local model to a manager agent without runner-kind filtering", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_runtime",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "local-endpoint-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "manager-agent-1",
          name: "Manager",
          workspace_id: workspaceId,
          type: "manager",
          model_settings: { primary: "openai/gpt-5.1" },
          tool_policy: {},
        },
      ],
      gateway_config: [] as Array<Record<string, unknown>>,
      gateway_config_versions: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "manager-agent-1" }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      routingRuleId: "local-rule-1",
      agentId: "manager-agent-1",
      model: "qwen3-coder:30b",
    });
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        }),
        expect.objectContaining({
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "manager-agent-1",
        }),
      ]),
    );
    expect(db.agent[0]).toMatchObject({
      model_settings: { primary: "qwen3-coder:30b" },
    });
    expect(db.routing_rule).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "agent:manager-agent-1:execution-profile",
          runner_kind: "llm_tool_runner",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
        }),
      ]),
    );
    const runtimeProfileRule = db.routing_rule.find(
      (rule) => rule.name === "agent:manager-agent-1:execution-profile",
    );
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: runtimeProfileRule?.id,
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        }),
      ]),
    );
    expect(db.gateway_config).toEqual([]);
    expect(db.gateway_config_versions).toEqual([]);
  });

  it("preserves existing assignments when assigning the same local model to another agent", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_runtime",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "match-1",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "planning-agent-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "planning-agent-1",
          workspace_id: workspaceId,
          type: "planning",
        },
        {
          id: "coding-agent-1",
          workspace_id: workspaceId,
          type: "coding",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "coding-agent-1" }),
      },
    );

    expect(response.status).toBe(201);
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "local-rule-1",
          value: "planning-agent-1",
        }),
        expect.objectContaining({
          rule_id: "local-rule-1",
          value: "coding-agent-1",
        }),
      ]),
    );
  });

  it("preserves non-local routing matches when replacing an agent's local model assignment", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_runtime",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
        {
          id: "old-local-rule",
          workspace_id: workspaceId,
          name: "local:llama3.1:8b",
          runner_kind: "local_runtime",
          model: "llama3.1:8b",
          provider: "openai_compatible",
        },
        {
          id: "cloud-rule-1",
          workspace_id: workspaceId,
          name: "cloud:openai:gpt-5.2",
          runner_kind: "llm_tool_runner",
          model: "openai/gpt-5.2",
          provider: "openai",
        },
      ],
      routing_rule_match: [
        {
          id: "old-local-match",
          workspace_id: workspaceId,
          rule_id: "old-local-rule",
          kind: "agent_id",
          key: "agent_id",
          value: "planning-agent-1",
        },
        {
          id: "cloud-match",
          workspace_id: workspaceId,
          rule_id: "cloud-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "planning-agent-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "planning-agent-1",
          workspace_id: workspaceId,
          type: "planning",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "planning-agent-1" }),
      },
    );

    expect(response.status).toBe(201);
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "cloud-rule-1",
          value: "planning-agent-1",
        }),
        expect.objectContaining({
          rule_id: "local-rule-1",
          value: "planning-agent-1",
        }),
      ]),
    );
    expect(db.routing_rule_match).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "old-local-rule",
          value: "planning-agent-1",
        }),
      ]),
    );
  });

  it("preserves an agent's credential-reference local_relay rule when assigning a registered runtime", async () => {
    // Regression: previously, the cleanup query that runs before saving a
    // local-runtime binding broadened to every workspace rule with
    // runner_kind = local_relay, including the credential-reference rule that
    // AgentModelPolicy writes when a user picks "Local relay". The DELETE then
    // wiped that rule's only agent_id match and broke the execution profile.
    const credentialRuleId = "credential-ref-rule";
    const registrationRuleId = "registration-rule";
    const db = {
      routing_rule: [
        {
          id: credentialRuleId,
          workspace_id: workspaceId,
          name: "agent:planning-agent-1:execution-profile",
          runner_kind: "local_relay",
          model: null,
          provider: "openclaw",
        },
        {
          id: registrationRuleId,
          workspace_id: workspaceId,
          name: "local:openclaw:machine-1",
          runner_kind: "local_relay",
          model: null,
          provider: "openclaw",
        },
      ],
      routing_rule_match: [
        {
          id: "credential-agent-match",
          workspace_id: workspaceId,
          rule_id: credentialRuleId,
          kind: "agent_id",
          key: "id",
          value: "planning-agent-1",
        },
        {
          id: "registration-machine-match",
          workspace_id: workspaceId,
          rule_id: registrationRuleId,
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "planning-agent-1",
          workspace_id: workspaceId,
          type: "planning",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/${registrationRuleId}/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "planning-agent-1" }),
      },
    );

    expect(response.status).toBe(201);
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: credentialRuleId,
          kind: "agent_id",
          value: "planning-agent-1",
        }),
        expect.objectContaining({
          rule_id: registrationRuleId,
          kind: "agent_id",
          value: "planning-agent-1",
        }),
      ]),
    );
  });

  it("unassigns a manager local model without mutating workspace gateway config", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_runtime",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "match-1",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "manager-agent-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "manager-agent-1",
          workspace_id: workspaceId,
          type: "manager",
        },
      ],
      gateway_config: [
        {
          id: "gateway-config-1",
          scope_type: "workspace",
          scope_id: workspaceId,
          version: 4,
          config_hash: "old-hash",
          config_json: {
            runners: {
              manager: {
                agent_id: "manager-agent-1",
                provider: "local",
                model: "qwen3-coder:30b",
                target_runner_kind: "local_runtime",
                min_cadence_ms: 60000,
              },
              coding: { provider: "openai" },
            },
          },
          updated_by: userId,
          updated_at: "2026-04-25T00:00:00.000Z",
        },
      ] as Array<Record<string, unknown>>,
      gateway_config_versions: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign/manager-agent-1?workspaceId=${workspaceId}`,
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(db.routing_rule_match).toEqual([]);
    expect(db.gateway_config[0]).toMatchObject({
      id: "gateway-config-1",
      version: 4,
      updated_by: userId,
      config_json: {
        runners: {
          manager: {
            agent_id: "manager-agent-1",
            provider: "local",
            model: "qwen3-coder:30b",
            target_runner_kind: "local_runtime",
            min_cadence_ms: 60000,
          },
          coding: { provider: "openai" },
        },
      },
    });
    expect(db.gateway_config_versions).toEqual([]);
  });

  it("registers a model-only runtime and emits an [runner.openai_compatible] snippet", async () => {
    const db = {
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            workspaceRoot: "/Users/me/project",
            toolCallCapability: "native_tools",
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      runners: Array<{
        kind: string;
        runnerKind: string;
        provider: string;
        model: string;
        toolCallCapability: string | null;
      }>;
      configSnippet: string;
      setupCommand: string;
    };
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0]).toMatchObject({
      kind: "openai_compatible",
      runnerKind: "local_runtime",
      provider: "openai_compatible",
      model: "qwen3-coder:30b",
      toolCallCapability: "native_tools",
    });
    expect(body.configSnippet).toContain("[runner.openai_compatible]");
    expect(body.configSnippet).toContain('model = "qwen3-coder:30b"');
    expect(body.configSnippet).not.toContain("[runner.openclaw]");
    expect(body.setupCommand).toContain('"$HELPER_BIN"');
    expect(body.setupCommand).toContain("'register'");
    expect(body.setupCommand).toContain("--openai-compatible-endpoint");
    expect(body.setupCommand).toContain("--openai-compatible-model");
    expect(body.setupCommand).toContain("--workspace-root");
    expect(body.setupCommand).toContain('"$HELPER_BIN" start');

    expect(db.routing_rule).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        runner_kind: "local_runtime",
        provider: "openai_compatible",
        model: "qwen3-coder:30b",
      }),
    ]);
    expect(db.local_runtime_machine[0]).toMatchObject({
      workspace_id: workspaceId,
      runner_kinds: expect.arrayContaining(["openai_compatible", "local_model_coding", "planner"]),
    });
  });

  it("registers an openclaw-only runtime and emits an [runner.openclaw] snippet", async () => {
    const db = {
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runners: [
          {
            kind: "openclaw",
            endpoint: "http://localhost:7100",
            apiKey: "sk-openclaw",
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      runners: Array<{
        kind: string;
        runnerKind: string;
        provider: string;
        model: string;
        toolCallCapability: string | null;
      }>;
      configSnippet: string;
      setupCommand: string;
    };
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0]).toMatchObject({
      kind: "openclaw",
      runnerKind: "local_relay",
      provider: "openclaw",
      model: "",
      toolCallCapability: null,
    });
    expect(body.configSnippet).toContain("[runner.openclaw]");
    expect(body.configSnippet).toContain('endpoint = "http://localhost:7100"');
    expect(body.configSnippet).toContain('api_key = "sk-openclaw"');
    expect(body.configSnippet).not.toContain("[runner.openai_compatible]");
    expect(body.configSnippet).not.toContain("model =");
    expect(body.setupCommand).toContain("--openclaw-endpoint");
    expect(body.setupCommand).toContain("--openclaw-api-key");

    expect(db.routing_rule).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        runner_kind: "local_relay",
        provider: "openclaw",
        model: null,
      }),
    ]);
    expect(db.local_runtime_machine[0]).toMatchObject({
      workspace_id: workspaceId,
      runner_kinds: ["openclaw"],
    });
  });

  it("registers a multi-kind runtime with both openai_compatible and openclaw runners on one machine", async () => {
    const db = {
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            toolCallCapability: "native_tools",
          },
          {
            kind: "openclaw",
            endpoint: "http://localhost:7100",
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      runners: Array<{ kind: string; runnerKind: string }>;
      configSnippet: string;
      setupCommand: string;
    };
    expect(body.runners.map((runner) => runner.kind).sort()).toEqual(["openai_compatible", "openclaw"]);
    expect(body.configSnippet).toContain("[runner.openai_compatible]");
    expect(body.configSnippet).toContain("[runner.openclaw]");
    expect(body.setupCommand).toContain("--openai-compatible-endpoint");
    expect(body.setupCommand).toContain("--openclaw-endpoint");

    expect(db.routing_rule).toHaveLength(2);
    expect(db.routing_rule).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runner_kind: "local_runtime",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
        }),
        expect.objectContaining({
          runner_kind: "local_relay",
          provider: "openclaw",
          model: null,
        }),
      ]),
    );
    expect(db.local_runtime_machine).toHaveLength(1);
    expect(db.local_runtime_machine[0]).toMatchObject({
      workspace_id: workspaceId,
      runner_kinds: expect.arrayContaining(["openai_compatible", "local_model_coding", "planner", "openclaw"]),
    });
  });

  it("rejects a registration that omits the runners array", async () => {
    const db = {
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "http://localhost:7100",
      }),
    });

    expect(response.status).toBe(400);
    expect(db.routing_rule).toEqual([]);
  });
});
