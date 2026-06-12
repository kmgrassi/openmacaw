import { beforeEach, describe, expect, it, vi } from "vitest";

import { findSetupAgentById } from "../repositories/agents.js";
import type * as AgentRepository from "../repositories/agents.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import type * as SupabaseClientModule from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";
import {
  addToolOverrideToAgent,
  appendToolExamples,
  applyToolPolicyTemplateToAgent,
  assignToolToAgent,
  createTool,
  deleteAgentToolGrant,
  getAgentToolSettings,
  getResolvedToolsForAgent,
  getToolsForAgent,
  listTools,
  removeToolOverrideFromAgent,
  replaceAgentToolBundles,
  setAgentToolGrant,
  unassignToolFromAgent,
  updateTool,
} from "./agent-tools.js";

vi.mock("../repositories/agents.js", async () => {
  const actual = await vi.importActual<typeof AgentRepository>("../repositories/agents.js");
  return {
    ...actual,
    findSetupAgentById: vi.fn(),
  };
});

vi.mock("../supabase-client.js", async () => {
  const actual = await vi.importActual<typeof SupabaseClientModule>("../supabase-client.js");
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

vi.mock("./work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const accessToken = "test-token";
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const toolId = "44444444-4444-4444-8444-444444444444";

type SetupAgent = NonNullable<Awaited<ReturnType<typeof findSetupAgentById>>>;

function agent(workspace = workspaceId, toolPolicy: SetupAgent["tool_policy"] = {}): SetupAgent {
  return {
    id: agentId,
    workspace_id: workspace,
    name: "Coding Agent",
    status: "ready",
    type: "coding" as const,
    model_settings: {},
    tool_policy: toolPolicy,
    created_by_user_id: userId,
    updated_at: "2026-04-26T12:00:00.000Z",
  };
}

function tool(overrides: Record<string, unknown> = {}) {
  return {
    id: toolId,
    workspace_id: null,
    slug: "read_file",
    name: "Read File",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    examples: [],
    function_name: "filesystem_read",
    execution_kind: "filesystem_read",
    runner_kind: "local_relay",
    enabled: true,
    created_by_user_id: null,
    ...overrides,
  };
}

describe("agent tool service", () => {
  type TableRows = Array<Record<string, unknown>>;
  let tables: {
    agent: TableRows;
    tool: TableRows;
    agent_tool: TableRows;
    agent_tool_grant: TableRows;
    tool_policy_template: TableRows;
    tool_policy_template_tool: TableRows;
  } & Record<string, TableRows>;

  beforeEach(() => {
    vi.restoreAllMocks();
    tables = {
      agent: [{ id: agentId, workspace_id: workspaceId, type: "coding", tool_bundles: [] }],
      tool: [tool()],
      agent_tool: [{ id: "assignment-1", agent_id: agentId, tool_id: toolId }],
      agent_tool_grant: [
        {
          id: "grant-1",
          agent_id: agentId,
          tool_id: toolId,
          workspace_id: workspaceId,
          mode: "include",
          source: "migration",
          source_tool_template_id: null,
          reason: null,
          created_by_user_id: userId,
        },
      ],
      tool_policy_template: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          workspace_id: null,
          slug: "coding",
          name: "Coding",
          description: "Coding tools",
          system_managed: true,
          enabled: true,
        },
      ],
      tool_policy_template_tool: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          workspace_id: null,
          template_id: "55555555-5555-4555-8555-555555555555",
          tool_id: toolId,
        },
      ],
      local_runtime_machine: [],
      routing_rule: [],
      routing_rule_match: [],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);
    vi.mocked(findSetupAgentById).mockResolvedValue(agent());
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
  });

  it("loads tools assigned to an authorized agent", async () => {
    await expect(getToolsForAgent({ accessToken, userId, agentId, workspaceId })).resolves.toEqual([
      expect.objectContaining({
        id: toolId,
        slug: "read_file",
        parameters: expect.objectContaining({ type: "object" }),
        executionKind: "filesystem_read",
        runnerKind: "local_relay",
      }),
    ]);
  });

  it("assigns a tool to an agent only once", async () => {
    await assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId });

    expect(tables.agent_tool_grant).toHaveLength(1);
  });

  it("creates a new tool definition with validated parameters", async () => {
    const created = await createTool({
      userId,
      request: {
        workspaceId,
        slug: "run_tests",
        name: "Run Tests",
        description: "Run the test suite",
        parameters: { type: "object", properties: { command: { type: "string" } } },
        executionKind: "shell",
        runnerKind: "local_relay",
      },
    });

    expect(created).toMatchObject({ slug: "run_tests", executionKind: "shell" });
    expect(tables.tool).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "run_tests",
          workspace_id: workspaceId,
          created_by_user_id: userId,
          execution_kind: "shell",
          runner_kind: "local_relay",
        }),
      ]),
    );
  });

  it("appends loose examples to a visible tool definition", async () => {
    tables.tool[0] = tool({
      examples: [{ input: { path: "README.md" } }],
    });

    const updated = await appendToolExamples({
      userId,
      toolId,
      request: {
        workspaceId,
        examples: [{ input: { path: "package.json" }, note: "Inspect dependencies." }],
      },
    });

    expect(updated.examples).toEqual([
      { input: { path: "README.md" } },
      { input: { path: "package.json" }, note: "Inspect dependencies." },
    ]);
    expect(tables.tool[0]).toEqual(
      expect.objectContaining({
        examples: [
          { input: { path: "README.md" } },
          { input: { path: "package.json" }, note: "Inspect dependencies." },
        ],
      }),
    );
  });

  it("rejects invalid JSON Schema parameter shapes", async () => {
    await expect(
      createTool({
        userId,
        request: {
          workspaceId,
          slug: "bad_tool",
          name: "Bad Tool",
          description: "",
          parameters: { type: "definitely-not-json-schema" },
          executionKind: null,
          runnerKind: null,
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_parameters_schema",
    });
  });

  it("returns not found when unassigning a missing assignment", async () => {
    await expect(
      unassignToolFromAgent({
        accessToken,
        userId,
        agentId,
        toolId: "55555555-5555-4555-8555-555555555555",
        workspaceId,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "agent_tool_not_found",
    });
  });

  it("does not return disabled assigned tools", async () => {
    tables.tool[0] = tool({ enabled: false });

    await expect(getToolsForAgent({ accessToken, userId, agentId, workspaceId })).resolves.toEqual([]);
  });

  it("prevents assigning disabled tool definitions", async () => {
    tables.tool[0] = tool({ enabled: false });
    tables.agent_tool_grant = [];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).rejects.toMatchObject({
      status: 409,
      code: "tool_disabled",
    });
  });

  it("prevents assigning local coding tools until a workspace execution target is registered", async () => {
    tables.tool[0] = tool({
      slug: "shell.exec",
      function_name: "shell_exec",
      execution_kind: "shell",
      runner_kind: "local_model_coding",
    });
    tables.agent_tool_grant = [];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).rejects.toMatchObject({
      status: 409,
      code: "local_coding_execution_target_required",
    });
  });

  it("allows assigning local coding tools when a local execution target has a workspace root", async () => {
    tables.tool[0] = tool({
      slug: "apply_patch",
      function_name: "apply_patch",
      execution_kind: "filesystem_write",
      runner_kind: "local_model_coding",
    });
    tables.agent_tool_grant = [];
    tables.local_runtime_machine = [
      {
        id: "machine-1",
        workspace_id: workspaceId,
        revoked_at: null,
      },
    ];
    tables.routing_rule = [
      {
        id: "rule-1",
        workspace_id: workspaceId,
        name: "local:qwen",
        runner_kind: "local_relay",
        enabled: true,
      },
    ];
    tables.routing_rule_match = [
      {
        id: "match-1",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_machine",
        key: "id",
        value: "machine-1",
      },
      {
        id: "match-2",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_workspace_root",
        key: "path",
        value: "/Users/dev/project",
      },
    ];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).resolves.toMatchObject({
      slug: "apply_patch",
    });
    expect(tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "manual",
        created_by_user_id: userId,
      }),
    ]);
  });

  it("allows assigning local coding tools when the agent uses container execution", async () => {
    vi.mocked(findSetupAgentById).mockResolvedValue(
      agent(workspaceId, {
        executionTarget: {
          kind: "container",
        },
      }),
    );
    tables.tool[0] = tool({
      slug: "shell.exec",
      function_name: "shell_exec",
      execution_kind: "shell",
      runner_kind: "local_model_coding",
    });
    tables.agent_tool_grant = [];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).resolves.toMatchObject({
      slug: "shell.exec",
    });
    expect(tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "manual",
        created_by_user_id: userId,
      }),
    ]);
  });

  it("allows applying coding tool templates when the agent uses container execution", async () => {
    vi.mocked(findSetupAgentById).mockResolvedValue(
      agent(workspaceId, {
        executionTarget: {
          kind: "container",
        },
      }),
    );
    tables.tool[0] = tool({
      slug: "apply_patch",
      function_name: "apply_patch",
      execution_kind: "filesystem_write",
      runner_kind: "local_model_coding",
    });
    tables.agent_tool_grant = [];

    await applyToolPolicyTemplateToAgent({
      accessToken,
      userId,
      agentId,
      templateId: "55555555-5555-4555-8555-555555555555",
      workspaceId,
    });

    expect(tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "template",
        created_by_user_id: userId,
      }),
    ]);
  });

  it("rejects local coding tool assignment for local runtime rules with a workspace root but no machine match", async () => {
    tables.tool[0] = tool({
      slug: "apply_patch",
      function_name: "apply_patch",
      execution_kind: "filesystem_write",
      runner_kind: "local_model_coding",
    });
    tables.agent_tool_grant = [];
    tables.local_runtime_machine = [{ id: "machine-1", workspace_id: workspaceId, revoked_at: null }];
    tables.routing_rule = [
      { id: "rule-1", workspace_id: workspaceId, name: "local:qwen", runner_kind: "local_relay", enabled: true },
    ];
    tables.routing_rule_match = [
      {
        id: "match-1",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_workspace_root",
        key: "path",
        value: "/Users/dev/project",
      },
    ];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).rejects.toMatchObject({
      status: 409,
      code: "local_coding_execution_target_required",
    });
  });

  it("allows local coding tool assignment when the routing rule references a non-first active machine", async () => {
    tables.tool[0] = tool({
      slug: "apply_patch",
      function_name: "apply_patch",
      execution_kind: "filesystem_write",
      runner_kind: "local_model_coding",
    });
    tables.agent_tool_grant = [];
    tables.local_runtime_machine = [
      { id: "machine-other", workspace_id: workspaceId, revoked_at: null },
      { id: "machine-target", workspace_id: workspaceId, revoked_at: null },
    ];
    tables.routing_rule = [
      { id: "rule-1", workspace_id: workspaceId, name: "local:qwen", runner_kind: "local_relay", enabled: true },
    ];
    tables.routing_rule_match = [
      {
        id: "match-1",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_machine",
        key: "id",
        value: "machine-target",
      },
      {
        id: "match-2",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_workspace_root",
        key: "path",
        value: "/Users/dev/project",
      },
    ];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).resolves.toMatchObject({
      slug: "apply_patch",
    });
    expect(tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "manual",
        created_by_user_id: userId,
      }),
    ]);
  });

  it("maps duplicate slug database failures through the Supabase error path", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue({
      from: () => ({
        insert: () => ({
          select: async () => ({
            data: null,
            error: {
              message: "duplicate key value violates unique constraint",
              code: "23505",
              details: null,
              hint: null,
              name: "PostgrestError",
            },
          }),
        }),
      }),
    } as never);

    await expect(
      createTool({
        userId,
        request: {
          workspaceId,
          slug: "read_file",
          name: "Read File",
          description: "",
          parameters: {},
          executionKind: null,
          runnerKind: null,
        },
      }),
    ).rejects.toThrow("duplicate key value violates unique constraint");
  });

  it("returns not found when updating a missing tool", async () => {
    await expect(
      updateTool({
        userId,
        toolId: "55555555-5555-4555-8555-555555555555",
        request: {
          workspaceId,
          name: "Missing",
        },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "tool_not_found",
    });
  });

  it("does not list tools scoped to a different workspace", async () => {
    tables.tool.push(
      tool({
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: "99999999-9999-4999-8999-999999999999",
        slug: "other_workspace_tool",
      }),
      tool({
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: workspaceId,
        slug: "workspace_tool",
      }),
    );

    const tools = await getToolsForAgent({ accessToken, userId, agentId, workspaceId });

    expect(tools.map((visibleTool) => visibleTool.slug)).toEqual(["read_file"]);
  });

  it("lists only global and requested-workspace tool definitions", async () => {
    tables.tool.push(
      tool({
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: "99999999-9999-4999-8999-999999999999",
        slug: "other_workspace_tool",
      }),
      tool({
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: workspaceId,
        slug: "workspace_tool",
      }),
    );

    const tools = await listTools({ userId, workspaceId });

    expect(tools.map((visibleTool) => visibleTool.slug)).toEqual(["read_file", "workspace_tool"]);
  });

  it("lists seeded local model coding tools with their runtime-owned runner kind", async () => {
    tables.tool = [
      tool({
        id: "55555555-5555-4555-8555-555555555555",
        slug: "shell.exec",
        name: "Shell Exec",
        function_name: "shell_exec",
        execution_kind: "shell",
        runner_kind: "local_model_coding",
        parameters: { type: "object", required: ["argv"] },
      }),
      tool({
        id: "66666666-6666-4666-8666-666666666666",
        slug: "apply_patch",
        name: "Apply Patch",
        function_name: "apply_patch",
        execution_kind: "filesystem_write",
        runner_kind: "local_model_coding",
        parameters: { type: "object", required: ["patch"] },
      }),
    ];

    const tools = await listTools({ userId, workspaceId });

    expect(tools).toEqual([
      expect.objectContaining({
        slug: "apply_patch",
        executionKind: "filesystem_write",
        runnerKind: "local_model_coding",
        enabled: true,
      }),
      expect.objectContaining({
        slug: "shell.exec",
        executionKind: "shell",
        runnerKind: "local_model_coding",
        enabled: true,
      }),
    ]);
  });

  it("resolves bundles, included extras, and excluded bundle tools for an agent", async () => {
    tables.agent = [{ id: agentId, workspace_id: workspaceId, type: "coding", tool_bundles: [":repo_read"] }];
    tables.tool = [
      tool({
        id: "tool-read",
        slug: "repo.read_file",
        name: "Read File",
        function_name: "repo_read_file",
      }),
      tool({
        id: "tool-search",
        slug: "repo.search",
        name: "Search",
        function_name: "repo_search",
      }),
      tool({
        id: "tool-shell",
        slug: "shell.exec",
        name: "Shell Exec",
        function_name: "shell_exec",
      }),
    ];
    tables.agent_tool_grant = [
      {
        id: "include-read",
        agent_id: agentId,
        tool_id: "tool-read",
        workspace_id: workspaceId,
        mode: "include",
        source: "template",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
      {
        id: "exclude-search",
        agent_id: agentId,
        tool_id: "tool-search",
        workspace_id: workspaceId,
        mode: "exclude",
        source: "manual",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
      {
        id: "include-shell",
        agent_id: agentId,
        tool_id: "tool-shell",
        workspace_id: workspaceId,
        mode: "include",
        source: "manual",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
    ];

    const result = await getResolvedToolsForAgent({ accessToken, userId, agentId, workspaceId });

    expect(result.bundles).toEqual([]);
    expect(
      result.tools.map((resolvedTool) => [resolvedTool.slug, resolvedTool.source, resolvedTool.enabledForAgent]),
    ).toEqual([
      ["repo.read_file", "include", true],
      ["repo.search", "exclude", false],
      ["shell.exec", "include", true],
    ]);
    await expect(getToolsForAgent({ accessToken, userId, agentId, workspaceId })).resolves.toEqual([
      expect.objectContaining({ slug: "repo.read_file" }),
      expect.objectContaining({ slug: "shell.exec" }),
    ]);
  });

  it("loads tool settings from templates, grants, and visible tools", async () => {
    tables.agent_tool_grant = [
      {
        id: "grant-include",
        agent_id: agentId,
        tool_id: toolId,
        workspace_id: workspaceId,
        mode: "include",
        source: "manual",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
    ];

    const settings = await getAgentToolSettings({ accessToken, userId, agentId, workspaceId });

    expect(settings.templates).toEqual([expect.objectContaining({ slug: "coding", name: "Coding" })]);
    expect(settings.availableTools).toEqual([expect.objectContaining({ id: toolId })]);
    expect(settings.grants).toEqual([
      expect.objectContaining({ agentId, toolId, workspaceId, mode: "include", source: "manual" }),
    ]);
    expect(settings.tools).toEqual([expect.objectContaining({ id: toolId, enabledForAgent: true, source: "manual" })]);
  });

  it("applies a template by writing include grants", async () => {
    tables.agent_tool_grant = [];

    await applyToolPolicyTemplateToAgent({
      accessToken,
      userId,
      agentId,
      templateId: "55555555-5555-4555-8555-555555555555",
      workspaceId,
    });

    expect(tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "template",
        source_tool_template_id: "55555555-5555-4555-8555-555555555555",
      }),
    ]);
    expect(tables.agent_tool).toHaveLength(1);
  });

  it("upserts manual include and exclude grants", async () => {
    await setAgentToolGrant({
      accessToken,
      userId,
      agentId,
      toolId,
      mode: "include",
      workspaceId,
    });
    await setAgentToolGrant({
      accessToken,
      userId,
      agentId,
      toolId,
      mode: "exclude",
      reason: "No file reads",
      workspaceId,
    });

    expect(tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        tool_id: toolId,
        workspace_id: workspaceId,
        mode: "exclude",
        source: "manual",
        reason: "No file reads",
      }),
    ]);
  });

  it("deletes grants without writing legacy agent_tool rows", async () => {
    tables.agent_tool_grant = [
      {
        id: "grant-1",
        agent_id: agentId,
        tool_id: toolId,
        workspace_id: workspaceId,
        mode: "include",
        source: "manual",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
    ];

    await deleteAgentToolGrant({ accessToken, userId, agentId, toolId, workspaceId });

    expect(tables.agent_tool_grant).toEqual([]);
    expect(tables.agent_tool).toHaveLength(1);
  });

  it("resolves effective grant rows for runtime dispatch", async () => {
    tables.agent = [{ id: agentId, workspace_id: workspaceId, type: "coding", tool_bundles: [":repo_read"] }];
    tables.tool = [
      tool({
        id: "tool-read",
        slug: "repo.read_file",
        name: "Read File",
        function_name: "repo_read_file",
      }),
      tool({
        id: "tool-shell",
        slug: "shell.exec",
        name: "Shell Exec",
        function_name: "shell_exec",
        execution_kind: "shell",
        runner_kind: "local_model_coding",
      }),
      tool({
        id: "tool-apply-patch",
        slug: "apply_patch",
        name: "Apply Patch",
        function_name: "apply_patch",
        execution_kind: "filesystem_write",
        runner_kind: "local_model_coding",
      }),
    ];
    tables.agent_tool = [];
    tables.agent_tool_grant = [
      {
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-shell",
        mode: "include",
        source: "template",
        source_tool_template_id: "template-local_model_coding",
      },
      {
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-apply-patch",
        mode: "include",
        source: "template",
        source_tool_template_id: "template-local_model_coding",
      },
    ];

    const result = await getResolvedToolsForAgent({ accessToken, userId, agentId, workspaceId });

    expect(result.bundles).toEqual([]);
    expect(
      result.tools.map((resolvedTool) => [
        resolvedTool.slug,
        resolvedTool.source,
        resolvedTool.enabledForAgent,
        resolvedTool.runnerKind,
      ]),
    ).toEqual([
      ["apply_patch", "include", true, "local_model_coding"],
      ["shell.exec", "include", true, "local_model_coding"],
    ]);
    await expect(getToolsForAgent({ accessToken, userId, agentId, workspaceId })).resolves.toEqual([
      expect.objectContaining({ slug: "apply_patch", runnerKind: "local_model_coding" }),
      expect.objectContaining({ slug: "shell.exec", runnerKind: "local_model_coding" }),
    ]);
  });

  it("adds and removes agent tool overrides by tool name", async () => {
    tables.tool = [
      tool({
        id: "tool-custom",
        slug: "custom_tool",
        name: "Custom Tool",
        function_name: "custom_tool",
      }),
    ];
    tables.agent_tool_grant = [];

    await addToolOverrideToAgent({
      accessToken,
      userId,
      agentId,
      toolName: "custom_tool",
      workspaceId,
    });
    expect(tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-custom",
        mode: "include",
        source: "manual",
        created_by_user_id: userId,
      }),
    ]);

    await removeToolOverrideFromAgent({
      accessToken,
      userId,
      agentId,
      toolName: "Custom Tool",
      workspaceId,
    });
    expect(tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-custom",
        mode: "exclude",
        source: "manual",
      }),
    ]);
  });

  it("replaces agent tool bundles with the allowlisted bundle names", async () => {
    await replaceAgentToolBundles({
      accessToken,
      userId,
      agentId,
      workspaceId,
      bundles: [":repo_read", ":repo_write"],
    });

    expect(tables.agent[0]).toEqual(
      expect.objectContaining({
        tool_bundles: [":repo_read", ":repo_write"],
      }),
    );
  });

  it("rejects unsupported agent tool bundles", async () => {
    await expect(
      replaceAgentToolBundles({
        accessToken,
        userId,
        agentId,
        workspaceId,
        bundles: [":repo_read", ":not_real" as ":repo_read"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_tool_bundle",
    });
  });

  it("prevents updates to global or cross-workspace tool definitions", async () => {
    await expect(
      updateTool({
        userId,
        toolId,
        request: {
          workspaceId,
          name: "Renamed Global Tool",
        },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "tool_not_found",
    });

    tables.tool.push(
      tool({
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: "99999999-9999-4999-8999-999999999999",
        slug: "other_workspace_tool",
      }),
    );

    await expect(
      updateTool({
        userId,
        toolId: "55555555-5555-4555-8555-555555555555",
        request: {
          workspaceId,
          name: "Renamed Other Workspace Tool",
        },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "tool_not_found",
    });
  });
});
