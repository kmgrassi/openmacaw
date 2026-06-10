import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { createLocalRuntimeTestServer, workspaceId } from "./local-runtime.test-support.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
}));

describe("local runtime route registration", () => {
  let closeServer = async () => {};
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    const server = await createLocalRuntimeTestServer();
    closeServer = server.close;
    baseUrl = server.baseUrl;
  });

  afterEach(async () => {
    await closeServer();
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
