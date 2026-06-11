import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
}));

const {
  deleteLocalRuntimeForWorkspace,
  listLocalRuntimesForWorkspace,
  registerLocalRuntimeForWorkspace,
  testLocalRuntimeDispatchForWorkspace,
} = await import("./local-runtime-machines.js");

describe("registerLocalRuntimeForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("adds local model coding and planner support when reusing an existing machine", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: userId,
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [],
      routing_rule: [],
      routing_rule_match: [],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
        ],
      },
    });

    expect(tables.local_runtime_machine[0]?.runner_kinds).toEqual([
      "openai_compatible",
      "local_model_coding",
      "planner",
    ]);
  });

  it("registers a new openclaw-only machine with runner_kinds: ['openclaw']", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openclaw",
            endpoint: "http://localhost:7100",
          },
        ],
      },
    });

    expect(tables.local_runtime_machine).toHaveLength(1);
    expect(tables.local_runtime_machine[0]).toMatchObject({
      runner_kinds: ["openclaw"],
    });
    expect(tables.routing_rule).toHaveLength(1);
    expect(tables.routing_rule[0]).toMatchObject({
      runner_kind: "local_relay",
      provider: "openclaw",
      model: null,
    });
  });

  it("registers a multi-kind machine with one routing rule per runner", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
          {
            kind: "openclaw",
            endpoint: "http://localhost:7100",
          },
        ],
      },
    });

    expect(tables.local_runtime_machine).toHaveLength(1);
    expect(tables.local_runtime_machine[0]?.runner_kinds).toEqual(
      expect.arrayContaining(["openai_compatible", "local_model_coding", "planner", "openclaw"]),
    );
    expect(tables.routing_rule).toHaveLength(2);
    expect(tables.routing_rule).toEqual(
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
  });

  it("revokes other active workspace machines and tokens when registering a machine", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [
        {
          id: "current-machine",
          workspace_id: workspaceId,
          user_id: userId,
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
        {
          id: "old-machine",
          workspace_id: workspaceId,
          user_id: userId,
          display_name: "llama3.1:8b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
        {
          id: "other-workspace-machine",
          workspace_id: "workspace-2",
          user_id: userId,
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [
        {
          id: "current-token",
          workspace_id: workspaceId,
          machine_id: "current-machine",
          token_hash: "current",
          revoked_at: null,
        },
        {
          id: "old-token",
          workspace_id: workspaceId,
          machine_id: "old-machine",
          token_hash: "old",
          revoked_at: null,
        },
        {
          id: "other-workspace-token",
          workspace_id: "workspace-2",
          machine_id: "other-workspace-machine",
          token_hash: "other",
          revoked_at: null,
        },
      ],
      routing_rule: [],
      routing_rule_match: [],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
        ],
      },
    });

    expect(tables.local_runtime_machine.find((machine) => machine.id === "current-machine")?.revoked_at).toBeNull();
    expect(tables.local_runtime_machine.find((machine) => machine.id === "old-machine")?.revoked_at).toEqual(
      expect.any(String),
    );
    expect(
      tables.local_runtime_machine.find((machine) => machine.id === "other-workspace-machine")?.revoked_at,
    ).toBeNull();
    expect(tables.local_runtime_token.find((token) => token.id === "old-token")?.revoked_at).toEqual(
      expect.any(String),
    );
    expect(tables.local_runtime_token.find((token) => token.id === "current-token")?.revoked_at).toBeNull();
    expect(tables.local_runtime_token.find((token) => token.id === "other-workspace-token")?.revoked_at).toBeNull();
  });

  it("repairs workspace-root local runtime rules with the registered machine id", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: userId,
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [],
      routing_rule: [
        {
          id: "existing-rule",
          workspace_id: workspaceId,
          runner_kind: "local_runtime",
          enabled: true,
        },
      ],
      routing_rule_match: [
        {
          id: "workspace-root-match",
          workspace_id: workspaceId,
          rule_id: "existing-rule",
          kind: "local_workspace_root",
          key: "path",
          value: "/tmp/workspace",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
        ],
      },
    });

    expect(tables.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspaceId,
          rule_id: "existing-rule",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        }),
      ]),
    );
  });
});

describe("deleteLocalRuntimeForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("revokes the local runtime machine and tokens after deleting the routing rules", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-1",
          workspace_id: workspaceId,
          runner_kind: "local_runtime",
        },
      ],
      routing_rule_match: [
        {
          id: "machine-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "agent-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "agent-1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [
        {
          id: "token-1",
          workspace_id: workspaceId,
          machine_id: "machine-1",
          token_hash: "hash",
          revoked_at: null,
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await deleteLocalRuntimeForWorkspace(workspaceId, "machine-1");

    expect(tables.routing_rule).toEqual([]);
    expect(tables.routing_rule_match).toEqual([]);
    expect(tables.local_runtime_machine[0]?.revoked_at).toEqual(expect.any(String));
    expect(tables.local_runtime_token[0]?.revoked_at).toEqual(expect.any(String));
  });

  it("removes all routing rules tied to a multi-kind machine in one delete", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-openai",
          workspace_id: workspaceId,
          runner_kind: "local_runtime",
        },
        {
          id: "rule-openclaw",
          workspace_id: workspaceId,
          runner_kind: "local_relay",
        },
      ],
      routing_rule_match: [
        {
          id: "machine-match-openai",
          workspace_id: workspaceId,
          rule_id: "rule-openai",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "machine-match-openclaw",
          workspace_id: workspaceId,
          rule_id: "rule-openclaw",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "multi-helper",
          runner_kinds: ["openai_compatible", "openclaw"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [
        {
          id: "token-1",
          workspace_id: workspaceId,
          machine_id: "machine-1",
          token_hash: "hash",
          revoked_at: null,
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await deleteLocalRuntimeForWorkspace(workspaceId, "machine-1");

    expect(tables.routing_rule).toEqual([]);
    expect(tables.routing_rule_match).toEqual([]);
    expect(tables.local_runtime_machine[0]?.revoked_at).toEqual(expect.any(String));
  });
});

describe("listLocalRuntimesForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects malformed routing metadata rows instead of trusting casted projections", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_runtime",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "machine-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "endpoint-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_endpoint",
          key: "url",
          value: null,
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          last_seen_at: null,
          revoked_at: null,
        },
      ],
      agent: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await expect(listLocalRuntimesForWorkspace(workspaceId)).rejects.toMatchObject({
      name: "SupabaseRowParseError",
      code: "invalid_supabase_row",
    });
  });

  it("ignores nullable match keys when a caller asks for a specific key", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_runtime",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "machine-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "legacy-null-key-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_workspace_root",
          key: null,
          value: "/tmp/legacy",
        },
        {
          id: "endpoint-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          last_seen_at: null,
          revoked_at: null,
        },
      ],
      agent: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await expect(listLocalRuntimesForWorkspace(workspaceId)).resolves.toMatchObject({
      runtimes: [
        {
          id: "machine-1",
          runners: [
            {
              id: "rule-1",
              endpoint: "http://127.0.0.1:11434/v1",
            },
          ],
        },
      ],
    });
  });
});

describe("testLocalRuntimeDispatchForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("fails before probing when the configured model is no longer advertised", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_runtime",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "machine-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "endpoint-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "Kevin's MacBook",
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
        },
      ],
      local_runtime_model: [
        {
          id: "model-1",
          machine_id: "machine-1",
          runner_kind: "local_runtime",
          model: "llama3.1:8b",
          provider: "openai_compatible",
          capabilities: {},
          last_advertised_at: new Date().toISOString(),
        },
      ],
      agent: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await expect(testLocalRuntimeDispatchForWorkspace(workspaceId, "machine-1")).resolves.toMatchObject({
      helperConnected: true,
      modelAdvertised: false,
      dispatchSucceeded: false,
      error: "Configured model is not currently advertised by the helper.",
    });
  });
});
