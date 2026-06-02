import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { executeDatabaseTool } from "./database-tool-executor.js";
import type { ToolDefinition } from "./tool-spec-translator.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const foreignAgentId = "44444444-4444-4444-8444-444444444444";

function scheduledTaskTool(slug: string): ToolDefinition {
  return {
    id: `tool-${slug}`,
    slug,
    name: slug,
    functionName: slug,
    description: "",
    parameters: {},
    executionKind: "database",
    runnerKind: "planner",
    enabled: true,
  };
}

describe("executeDatabaseTool scheduled_task tools", () => {
  let tables: Record<string, Array<Record<string, unknown>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    tables = {
      agent: [
        { id: agentId, workspace_id: workspaceId },
        { id: foreignAgentId, workspace_id: "foreign-workspace" },
      ],
      tool: [
        {
          id: "tool-repo-read",
          workspace_id: null,
          slug: "repo.read_file",
          name: "Read File",
          examples: [{ input: { path: "README.md" } }],
        },
        {
          id: "foreign-tool",
          workspace_id: "foreign-workspace",
          slug: "foreign.tool",
          name: "Foreign Tool",
          examples: [],
        },
      ],
      agent_tool_grant: [
        {
          id: "grant-repo-read",
          agent_id: agentId,
          workspace_id: workspaceId,
          tool_id: "tool-repo-read",
          mode: "include",
        },
      ],
      scheduled_task: [
        {
          id: "scheduled-task-1",
          agent_id: agentId,
          instructions: "Review open work.",
          cron_schedule: null,
          next_interval: { kind: "every", interval: 1, unit: "day" },
          start_time: null,
          is_active: true,
          is_completed: false,
          is_follow_up: false,
          cancelled_reason: null,
        },
        {
          id: "foreign-scheduled-task",
          agent_id: foreignAgentId,
          instructions: "Foreign work.",
          is_active: true,
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);
  });

  it("creates a scheduled task for the runtime agent in the current workspace", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("scheduled_task.create"),
      {
        instructions: "Check blocked PRs.",
        schedule: { kind: "every", interval: 1, unit: "hour" },
      },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(201);
    expect(JSON.parse(result.output)).toMatchObject({
      scheduledTask: {
        agent_id: agentId,
        instructions: "Check blocked PRs.",
        next_interval: { kind: "every", interval: 1, unit: "hour" },
        is_active: true,
      },
    });
  });

  it("lists only scheduled tasks owned by agents in the runtime workspace", async () => {
    const result = await executeDatabaseTool(scheduledTaskTool("scheduled_task.list"), {}, { workspaceId, agentId });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output).scheduledTasks.map((task: { id: string }) => task.id)).toEqual([
      "scheduled-task-1",
    ]);
  });

  it("rejects cross-workspace scheduled task reads", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("scheduled_task.read"),
        { scheduledTaskId: "foreign-scheduled-task" },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: "agent_not_found",
    });
  });

  it("soft-cancels scheduled tasks instead of deleting rows", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("scheduled_task.delete"),
      { scheduledTaskId: "scheduled-task-1", reason: "User canceled it." },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(200);
    const scheduledTasks = tables.scheduled_task;
    expect(scheduledTasks).toHaveLength(2);
    expect(scheduledTasks?.[0]).toMatchObject({
      id: "scheduled-task-1",
      is_active: false,
      is_completed: true,
      cancelled_reason: "User canceled it.",
    });
  });

  it("executes memory.search only when learning is enabled for the runtime agent", async () => {
    tables.agent = [
      {
        id: agentId,
        workspace_id: workspaceId,
      },
    ];
    tables.workspaces = [{ id: workspaceId, settings: { learning: { enabled: true } } }];
    tables.memory_items = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: workspaceId,
        agent_id: null,
        content: "This repo uses pnpm for package scripts.",
        importance: 9,
        scope: "long_term",
        tags: {},
        source_run_id: null,
        source_task_id: null,
        event_time: "2026-04-25T00:00:00.000Z",
        is_deleted: false,
      },
    ];

    const result = await executeDatabaseTool(
      scheduledTaskTool("memory.search"),
      { query: "pnpm", limit: 20, importance_min: 1 },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output)).toMatchObject({
      resultCount: 1,
      results: [
        {
          content: "This repo uses pnpm for package scripts.",
          importance: 9,
          scope: "long_term",
        },
      ],
    });
  });

  it("appends examples to a tool assigned to the runtime agent", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("tool_examples.append"),
      {
        tool_slug: "repo.read_file",
        example: {
          when: "Need package metadata.",
          input: { path: "package.json" },
        },
      },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output)).toMatchObject({
      appendedCount: 1,
      exampleCount: 2,
      tool: {
        id: "tool-repo-read",
        slug: "repo.read_file",
      },
    });
    expect(tables.tool?.[0]?.examples).toEqual([
      { input: { path: "README.md" } },
      { when: "Need package metadata.", input: { path: "package.json" } },
    ]);
  });

  it("rejects tool example updates for tools not assigned to the runtime agent", async () => {
    tables.tool?.push({
      id: "tool-unassigned",
      workspace_id: null,
      slug: "repo.search",
      name: "Search",
      examples: [],
    });

    await expect(
      executeDatabaseTool(
        scheduledTaskTool("tool_examples.append"),
        {
          tool_slug: "repo.search",
          example: { input: { query: "ToolDefinition" } },
        },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "tool_not_assigned",
    });
  });

  it("rejects memory.search when learning is disabled", async () => {
    tables.agent = [{ id: agentId, workspace_id: workspaceId, tool_policy: { learning: { enabled: true } } }];
    tables.workspaces = [{ id: workspaceId, settings: { learning: { enabled: false } } }];

    await expect(
      executeDatabaseTool(scheduledTaskTool("memory.search"), { query: "pnpm" }, { workspaceId, agentId }),
    ).rejects.toMatchObject({
      status: 403,
      code: "learning_disabled",
    });
  });
});
