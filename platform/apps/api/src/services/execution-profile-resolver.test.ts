import { beforeEach, describe, expect, it, vi } from "vitest";

import { firstGatewayRunner, matchValue, resolveExecutionProfile } from "./execution-profile-resolver.js";

let selectRowsForTable: (table: string, params: URLSearchParams) => unknown[] | Promise<unknown[]> = () => [];

vi.mock("../supabase-client.js", () => {
  function mockClient() {
    return {
      from(table: string) {
        const params = new URLSearchParams();
        const query = {
          select(columns: string) {
            params.set("select", columns);
            return query;
          },
          eq(column: string, value: unknown) {
            params.set(column, `eq.${String(value)}`);
            return query;
          },
          in(column: string, values: unknown[]) {
            params.set(column, `in.(${values.map(String).join(",")})`);
            return query;
          },
          order(column: string, options?: { ascending?: boolean }) {
            const direction = options?.ascending === true ? "asc" : "desc";
            const existing = params.get("order");
            params.set("order", existing ? `${existing},${column}.${direction}` : `${column}.${direction}`);
            return query;
          },
          limit(count: number) {
            params.set("limit", String(count));
            return query;
          },
          then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
            onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) {
            return Promise.resolve()
              .then(() => selectRowsForTable(table, params))
              .then((data) => ({ data, error: null }))
              .then(onfulfilled, onrejected);
          },
        };
        return query;
      },
    };
  }

  return {
    getServiceRoleSupabase: mockClient,
    getUserScopedSupabase: mockClient,
    normalizeSupabaseError: (_context: string, error: unknown) => error,
  };
});

const workspaceId = "22222222-2222-4222-8222-222222222222";
const planningAgentId = "11111111-1111-4111-8111-111111111111";
const codingAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const managerAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const anthropicCredentialId = "33333333-3333-4333-8333-333333333333";
const codexCredentialId = "44444444-4444-4444-8444-444444444444";

function tableParams(params: URLSearchParams) {
  return Object.fromEntries(params.entries());
}

function setupMockDatabase(overrides: Partial<Record<string, Array<Record<string, unknown>>>> = {}) {
  const db: Record<string, Array<Record<string, unknown>>> = {
    agent: [
      {
        id: planningAgentId,
        workspace_id: workspaceId,
        type: "planning",
        model_settings: { primary: "openai/gpt-5.2" },
        tool_policy: {},
      },
      {
        id: codingAgentId,
        workspace_id: workspaceId,
        type: "coding",
        model_settings: { primary: "openai/gpt-5.1-codex" },
        tool_policy: {},
      },
    ],
    routing_rule: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: workspaceId,
        priority: 20,
        enabled: true,
        runner_kind: "llm_tool_runner",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        credential_id: null,
        credential_alias: "default-anthropic",
        next_fallback_rule_id: null,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: workspaceId,
        priority: 10,
        enabled: true,
        runner_kind: "codex",
        provider: "openai_codex",
        model: "gpt-5.1-codex",
        credential_id: codexCredentialId,
        credential_alias: null,
        next_fallback_rule_id: null,
      },
    ],
    routing_rule_match: [
      {
        rule_id: "55555555-5555-4555-8555-555555555555",
        workspace_id: workspaceId,
        kind: "agent_type",
        key: null,
        value: "planning",
      },
      {
        rule_id: "66666666-6666-4666-8666-666666666666",
        workspace_id: workspaceId,
        kind: "agent_type",
        key: null,
        value: "coding",
      },
    ],
    credential_alias: [
      {
        workspace_id: workspaceId,
        alias: "default-anthropic",
        credential_id: anthropicCredentialId,
      },
    ],
    credential: [
      {
        id: codexCredentialId,
        workspace_id: workspaceId,
        key_value: { agent_id: codingAgentId },
      },
    ],
    gateway_config: [
      {
        scope_type: "agent",
        scope_id: codingAgentId,
        version: 1,
        config_json: {
          runners: [
            {
              kind: "codex",
              provider: "openai_codex",
              model: "gpt-5.1-codex",
            },
          ],
        },
      },
    ],
    ...overrides,
  };

  selectRowsForTable = (table: string, params: URLSearchParams) => {
    const query = tableParams(params);
    let rows = [...(db[table] ?? [])];

    rows = rows.filter((row) => {
      for (const [key, value] of Object.entries(query)) {
        if (key === "select" || key === "order" || key === "limit") continue;
        if (value.startsWith("eq.") && String(row[key]) !== value.slice(3)) return false;
        if (value.startsWith("in.")) {
          const allowed = value
            .slice(4, -1)
            .split(",")
            .map((item) => item.trim());
          if (!allowed.includes(String(row[key]))) return false;
        }
      }
      return true;
    });

    if (query.order === "priority.desc,created_at.asc") {
      rows.sort((left, right) => Number(right.priority) - Number(left.priority));
    }

    const limit = query.limit ? Number(query.limit) : null;
    return (limit ? rows.slice(0, limit) : rows) as never;
  };

  return db;
}

describe("resolveExecutionProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves planning and coding agents to different providers in one workspace", async () => {
    setupMockDatabase();

    const planning = await resolveExecutionProfile({ agentId: planningAgentId });
    const coding = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(planning.profile).toMatchObject({
      agentId: planningAgentId,
      role: "planning",
      runnerKind: "llm_tool_runner",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      credentialRef: { type: "credential_id", value: anthropicCredentialId },
      toolProfile: "planning",
    });
    expect(planning.missing).toEqual([]);
    expect(planning.source).toMatchObject({
      routingRuleId: "55555555-5555-4555-8555-555555555555",
      credentialAlias: "default-anthropic",
      fallbackUsed: false,
    });

    expect(coding.profile).toMatchObject({
      agentId: codingAgentId,
      role: "coding",
      runnerKind: "codex",
      provider: "openai_codex",
      model: "gpt-5.1-codex",
      credentialRef: { type: "credential_id", value: codexCredentialId },
      toolProfile: "coding",
    });
    expect(coding.missing).toEqual([]);
  });

  it("resolves a Claude Code coding profile without normalizing it to Codex", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "claude_code",
          provider: "anthropic",
          model: "sonnet",
          credential_id: null,
          credential_alias: "default-anthropic",
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "coding",
        },
      ],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      agentId: codingAgentId,
      role: "coding",
      runnerKind: "claude_code",
      provider: "anthropic",
      model: "sonnet",
      credentialRef: { type: "credential_id", value: anthropicCredentialId },
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: false,
        interrupt: false,
      },
    });
    expect(resolution.missing).toEqual([]);
    expect(resolution.source).toMatchObject({
      routingRuleId: "77777777-7777-4777-8777-777777777777",
      credentialAlias: "default-anthropic",
      fallbackUsed: false,
    });
  });

  it("resolves a Claude Code coding profile with a full Anthropic model id", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "claude_code",
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4-6",
          credential_id: anthropicCredentialId,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "coding",
        },
      ],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "claude_code",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      credentialRef: { type: "credential_id", value: anthropicCredentialId },
    });
    expect(resolution.missing).toEqual([]);
  });

  it("falls back to legacy agent model settings and gateway config", async () => {
    setupMockDatabase({
      routing_rule: [],
      routing_rule_match: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "codex",
      provider: "openai_codex",
      model: "gpt-5.1-codex",
      credentialRef: { type: "credential_id", value: codexCredentialId },
    });
    expect(resolution.source).toEqual({
      routingRuleId: null,
      credentialAlias: null,
      fallbackUsed: true,
      legacyGatewayConfigUsed: true,
    });
  });

  it("does not 502 when legacy credential.agent_id lookup is unavailable", async () => {
    setupMockDatabase({
      routing_rule: [],
      routing_rule_match: [],
      credential: [],
    });
    selectRowsForTable = (table: string, params: URLSearchParams) => {
      const query = tableParams(params);
      if (table === "credential" && query.agent_id) {
        throw new Error(
          'Supabase credential query failed (400): {"code":"42703","message":"column credential.agent_id does not exist"}',
        );
      }

      const rowsByTable: Record<string, Array<Record<string, unknown>>> = {
        agent: [
          {
            id: codingAgentId,
            workspace_id: workspaceId,
            type: "coding",
            model_settings: { primary: "openai/gpt-5.1-codex" },
            tool_policy: {},
          },
        ],
        routing_rule: [],
        routing_rule_match: [],
        gateway_config: [
          {
            scope_type: "agent",
            scope_id: codingAgentId,
            version: 1,
            config_json: {
              runners: [{ kind: "codex", provider: "openai_codex", model: "gpt-5.1-codex" }],
            },
          },
        ],
        credential: [],
      };

      const rows = [...(rowsByTable[table] ?? [])].filter((row) => {
        for (const [key, value] of Object.entries(query)) {
          if (key === "select" || key === "order" || key === "limit") continue;
          if (value.startsWith("eq.") && String(row[key]) !== value.slice(3)) return false;
        }
        return true;
      });
      const limit = query.limit ? Number(query.limit) : null;
      return (limit ? rows.slice(0, limit) : rows) as never;
    };

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "codex",
      provider: "openai_codex",
      model: "gpt-5.1-codex",
      credentialRef: null,
    });
    expect(resolution.missing).toContain("credential");
  });

  it("falls back to legacy gateway config when routing tables are unavailable", async () => {
    setupMockDatabase();
    selectRowsForTable = (table: string, params: URLSearchParams) => {
      if (table === "routing_rule" || table === "routing_rule_match") {
        throw new Error(`${table} is not readable`);
      }

      const query = tableParams(params);
      const rowsByTable: Record<string, Array<Record<string, unknown>>> = {
        agent: [
          {
            id: codingAgentId,
            workspace_id: workspaceId,
            type: "coding",
            model_settings: { primary: "openai/gpt-5.1-codex" },
            tool_policy: {},
          },
        ],
        gateway_config: [
          {
            scope_type: "agent",
            scope_id: codingAgentId,
            version: 1,
            config_json: {
              runners: [{ kind: "codex", provider: "openai_codex", model: "gpt-5.1-codex" }],
            },
          },
        ],
        credential: [{ id: codexCredentialId, workspace_id: workspaceId, key_value: { agent_id: codingAgentId } }],
      };
      let rows = [...(rowsByTable[table] ?? [])];
      rows = rows.filter((row) => {
        for (const [key, value] of Object.entries(query)) {
          if (key === "select" || key === "order" || key === "limit") continue;
          if (value.startsWith("eq.") && String(row[key]) !== value.slice(3)) return false;
        }
        return true;
      });
      const limit = query.limit ? Number(query.limit) : null;
      return (limit ? rows.slice(0, limit) : rows) as never;
    };

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "codex",
      provider: "openai_codex",
      model: "gpt-5.1-codex",
      credentialRef: { type: "credential_id", value: codexCredentialId },
    });
    expect(resolution.source).toMatchObject({
      routingRuleId: null,
      fallbackUsed: true,
      legacyGatewayConfigUsed: true,
    });
  });

  it("evaluates explicit fallback rules before returning an unresolved profile", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          credential_id: null,
          credential_alias: "missing-alias",
          next_fallback_rule_id: "88888888-8888-4888-8888-888888888888",
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          workspace_id: workspaceId,
          priority: 1,
          enabled: true,
          runner_kind: "codex",
          provider: "openai_codex",
          model: "gpt-5.1-codex",
          credential_id: codexCredentialId,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "planning",
        },
      ],
      credential_alias: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: planningAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "codex",
      provider: "openai_codex",
      credentialRef: { type: "credential_id", value: codexCredentialId },
    });
    expect(resolution.missing).toEqual([]);
    expect(resolution.source.routingRuleId).toBe("88888888-8888-4888-8888-888888888888");
  });

  it("resolves local model coding routing rules without credential drift", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen2.5-coder:latest",
          credential_id: null,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "99999999-9999-4999-8999-999999999999",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "coding",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      agentId: codingAgentId,
      role: "coding",
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model: "qwen2.5-coder:latest",
      credentialRef: null,
      toolProfile: "coding",
      workspacePolicy: {
        sandbox: "workspace_write",
        approvalPolicy: "on_request",
      },
      capabilityRequirements: {
        toolCalls: true,
        jsonMode: true,
      },
      capabilities: {
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: true,
      },
    });
    expect(resolution.missing).toEqual([]);
  });

  it("prefers local model coding when duplicate agent routes have the same priority", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "local_runtime",
          provider: "openai_compatible",
          model: "qwen2.5-coder:latest",
          credential_id: null,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
        {
          id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
          credential_id: null,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          kind: "agent_id",
          key: "agent_id",
          value: codingAgentId,
        },
        {
          rule_id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          kind: "agent_id",
          key: "id",
          value: codingAgentId,
        },
        {
          rule_id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          kind: "local_workspace_root",
          key: "path",
          value: "/tmp/workspace",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model: "qwen3-coder:30b",
    });
    expect(resolution.missing).toEqual([]);
  });

  it("does not count local metadata rows as routing specificity", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
          credential_id: null,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
        {
          id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          credential_id: anthropicCredentialId,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: "type",
          value: "coding",
        },
        {
          rule_id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          kind: "local_workspace_root",
          key: "path",
          value: "/tmp/workspace",
        },
        {
          rule_id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          rule_id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: "type",
          value: "coding",
        },
        {
          rule_id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          kind: "intent",
          key: null,
          value: "draft_plan",
        },
      ],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId, intent: "draft_plan" });

    expect(resolution.profile).toMatchObject({
      runnerKind: "llm_tool_runner",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  it("resolves planner local routing rules without hosted credentials", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "10101010-1010-4010-8010-101010101010",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "planner",
          provider: "local",
          model: "qwen2.5-coder:7b",
          credential_id: null,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "10101010-1010-4010-8010-101010101010",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "planning",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: planningAgentId });

    expect(resolution.profile).toMatchObject({
      agentId: planningAgentId,
      role: "planning",
      runnerKind: "planner",
      provider: "local",
      model: "qwen2.5-coder:7b",
      credentialRef: null,
      toolProfile: "planning",
      capabilities: {
        toolCalls: true,
        workspaceWrite: false,
        structuredOutput: true,
      },
    });
    expect(resolution.missing).toEqual([]);
  });

  it("resolves OpenAI-compatible manager routing rules without hosted credentials", async () => {
    setupMockDatabase({
      agent: [
        {
          id: managerAgentId,
          workspace_id: workspaceId,
          type: "manager",
          model_settings: { primary: "qwen3-coder:30b" },
          tool_policy: {},
        },
      ],
      routing_rule: [
        {
          id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
          credential_id: null,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          workspace_id: workspaceId,
          kind: "agent_id",
          key: "id",
          value: managerAgentId,
        },
        {
          rule_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          workspace_id: workspaceId,
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: managerAgentId });

    expect(resolution.profile).toMatchObject({
      agentId: managerAgentId,
      role: "manager",
      runnerKind: "llm_tool_runner",
      provider: "openai_compatible",
      model: "qwen3-coder:30b",
      credentialRef: null,
      toolProfile: "manager",
    });
    expect(resolution.missing).toEqual([]);
  });

  it("returns explicit missing requirements without leaking credential material", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "",
          provider: null,
          model: null,
          credential_id: null,
          credential_alias: "missing-alias",
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [],
      credential_alias: [],
      agent: [
        {
          id: planningAgentId,
          workspace_id: workspaceId,
          type: "planning",
          model_settings: {},
          tool_policy: {},
        },
      ],
    });

    const resolution = await resolveExecutionProfile({ agentId: planningAgentId });

    expect(resolution.profile).toBeNull();
    expect(resolution.missing).toEqual(["runner", "provider", "model", "credential"]);
    expect(JSON.stringify(resolution)).not.toContain("sk-");
  });

  it("uses intent match keys to distinguish namespaced routing predicates", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "codex",
          provider: "openai_codex",
          model: "gpt-5.1-codex",
          credential_id: codexCredentialId,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
        {
          id: "99999999-9999-4999-8999-999999999999",
          workspace_id: workspaceId,
          priority: 10,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          credential_id: anthropicCredentialId,
          credential_alias: null,
          next_fallback_rule_id: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "88888888-8888-4888-8888-888888888888",
          workspace_id: workspaceId,
          kind: "intent",
          key: "workflow",
          value: "draft_plan",
        },
        {
          rule_id: "99999999-9999-4999-8999-999999999999",
          workspace_id: workspaceId,
          kind: "intent",
          key: null,
          value: "draft_plan",
        },
      ],
    });

    const unkeyed = await resolveExecutionProfile({ agentId: planningAgentId, intent: "draft_plan" });
    const keyed = await resolveExecutionProfile({
      agentId: planningAgentId,
      intent: "draft_plan",
      intentKey: "workflow",
    });

    expect(unkeyed.profile).toMatchObject({
      runnerKind: "llm_tool_runner",
      provider: "anthropic",
    });
    expect(keyed.profile).toMatchObject({
      runnerKind: "codex",
      provider: "openai_codex",
    });
  });
});

describe("matchValue", () => {
  const agent = {
    id: planningAgentId,
    workspace_id: workspaceId,
    type: "planning",
    model_settings: {},
    tool_policy: {},
  };
  const input = { agent, role: "planning" as const, intent: null, intentKey: null };

  it('accepts key: "agent_id" for kind: "agent_id" matches', () => {
    const match = { rule_id: "r1", kind: "agent_id", key: "agent_id", value: planningAgentId };
    expect(matchValue(input, match)).toBe(true);
  });

  it('accepts key: "id" for kind: "agent_id" matches', () => {
    const match = { rule_id: "r1", kind: "agent_id", key: "id", value: planningAgentId };
    expect(matchValue(input, match)).toBe(true);
  });

  it("accepts null key for kind: agent_id matches", () => {
    const match = { rule_id: "r1", kind: "agent_id", key: null, value: planningAgentId };
    expect(matchValue(input, match)).toBe(true);
  });

  it("rejects agent_id match when value does not match the agent id", () => {
    const match = { rule_id: "r1", kind: "agent_id", key: "agent_id", value: "wrong-id" };
    expect(matchValue(input, match)).toBe(false);
  });

  it('skips kind: "local_endpoint" (returns true, does not block)', () => {
    const match = { rule_id: "r1", kind: "local_endpoint", key: "url", value: "http://localhost:8080" };
    expect(matchValue(input, match)).toBe(true);
  });
});

describe("firstGatewayRunner", () => {
  it("returns the first array entry for default-agent configs", () => {
    const config = {
      runners: [
        { kind: "codex", provider: "openai", model: "openai/gpt-5.2" },
        { kind: "claude_code", provider: "anthropic", model: "anthropic/claude-sonnet-4-6" },
      ],
    };
    expect(firstGatewayRunner(config)).toEqual({
      kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
    });
  });

  it("returns the manager entry for object-shaped manager configs", () => {
    const config = {
      runners: {
        manager: { kind: "llm_tool_runner", provider: "openai", model: "openai/gpt-5.2" },
      },
    };
    expect(firstGatewayRunner(config)).toEqual({
      kind: "llm_tool_runner",
      provider: "openai",
      model: "openai/gpt-5.2",
    });
  });

  it("falls back to the first record-valued entry when manager key is absent", () => {
    const config = {
      runners: {
        coding: { kind: "codex", provider: "openai", model: "openai/gpt-5.2" },
      },
    };
    expect(firstGatewayRunner(config)).toEqual({
      kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
    });
  });

  it("returns null for empty / missing / non-record runners", () => {
    expect(firstGatewayRunner(null)).toBeNull();
    expect(firstGatewayRunner({})).toBeNull();
    expect(firstGatewayRunner({ runners: [] })).toBeNull();
    expect(firstGatewayRunner({ runners: {} })).toBeNull();
    expect(firstGatewayRunner({ runners: { manager: "not a record" } })).toBeNull();
  });
});
