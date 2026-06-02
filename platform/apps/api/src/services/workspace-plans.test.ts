import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import {
  deletePlanForWorkspace,
  deleteWorkItemForWorkspace,
  listPlansForWorkspace,
  listWorkItemsForWorkspace,
} from "./workspace-plans.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const planId = "33333333-3333-4333-8333-333333333333";
const workItemId = "44444444-4444-4444-8444-444444444444";
const plannerWorkItemId = "66666666-6666-4666-8666-666666666666";

type TableRows = Record<string, unknown>[];
const tables: { plan: TableRows; work_items: TableRows; task: TableRows; event_log: TableRows } & Record<
  string,
  TableRows
> = {
  plan: [],
  work_items: [],
  task: [],
  event_log: [],
};
const mockClient = createMockSupabaseClient(tables);

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: () => mockClient,
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: null }>) => {
    const { data } = await query;
    return Array.isArray(data) ? data : data ? [data] : [];
  },
}));

function resetTables() {
  tables.plan = [
    {
      id: planId,
      workspace_id: workspaceId,
      name: "Manager agent rollout",
      description: "Ship the manager agent.",
      status: "pending",
      metadata: {},
      schema_version: "1",
      intent: "Ship the manager agent.",
      default_runner_kind: "codex",
      default_model: "gpt-5.2",
      created_at: "2026-04-25T12:00:00.000Z",
      updated_at: "2026-04-25T12:00:00.000Z",
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      workspace_id: otherWorkspaceId,
      name: "Other workspace plan",
      description: null,
      status: "pending",
      metadata: {},
      schema_version: "1",
      intent: null,
      default_runner_kind: null,
      default_model: null,
      created_at: "2026-04-25T12:00:00.000Z",
      updated_at: "2026-04-25T12:00:00.000Z",
    },
  ];
  tables.work_items = [
    {
      id: workItemId,
      task_id: null,
      workspace_id: workspaceId,
      plan_id: planId,
      identifier: "WI-1",
      title: "Create manager settings",
      description: "Add manager settings controls.",
      instructions: "Add manager settings controls.",
      state: "todo",
      priority: null,
      source: "api",
      runner_kind: "codex",
      repository: "parallel-agent-platform",
      labels: [],
      depends_on: [],
      completion_gates: [],
      metadata: {},
      next_poll_at: null,
      last_polled_at: null,
      poll_cadence_seconds: 300,
      created_at: "2026-04-25T12:00:00.000Z",
      updated_at: "2026-04-25T12:00:00.000Z",
    },
    {
      id: plannerWorkItemId,
      task_id: null,
      workspace_id: workspaceId,
      plan_id: planId,
      identifier: "WI-PLANNER",
      title: "Planner-created item",
      description: "Created by the runtime planner task.create tool.",
      instructions: "Run the planner-created task.",
      state: "todo",
      priority: null,
      source: "planner",
      runner_kind: "local_relay",
      repository: "parallel-agent-runtime",
      labels: [],
      depends_on: [],
      completion_gates: [],
      metadata: {
        created_via: "planner_task_tool",
        planner_tool: "task.create",
      },
      next_poll_at: null,
      last_polled_at: null,
      poll_cadence_seconds: 300,
      created_at: "2026-04-25T12:00:00.000Z",
      updated_at: "2026-04-25T12:01:00.000Z",
    },
    {
      id: "88888888-8888-4888-8888-888888888888",
      task_id: null,
      workspace_id: otherWorkspaceId,
      plan_id: null,
      identifier: "WI-2",
      title: "Other workspace item",
      description: null,
      instructions: null,
      state: "todo",
      priority: null,
      source: "api",
      labels: [],
      depends_on: [],
      completion_gates: [],
      metadata: {},
      next_poll_at: null,
      last_polled_at: null,
      poll_cadence_seconds: 300,
      created_at: "2026-04-25T12:00:00.000Z",
      updated_at: "2026-04-25T12:00:00.000Z",
    },
  ];
  tables.task = [
    {
      id: "55555555-5555-4555-8555-555555555555",
      workspace_id: workspaceId,
      plan_id: planId,
      name: "Legacy task row",
    },
  ];
  tables.event_log = [];
  vi.clearAllMocks();
}

describe("workspace plans and work items service", () => {
  beforeEach(() => {
    resetTables();
  });

  it("lists plans and work items from workspace-scoped tables", async () => {
    const plans = await listPlansForWorkspace(workspaceId);
    const workItems = await listWorkItemsForWorkspace(workspaceId);

    expect(plans.plans).toHaveLength(1);
    expect(plans.plans[0]?.id).toBe(planId);
    expect(workItems.workItems).toHaveLength(2);
    expect(workItems.workItems.map((workItem) => workItem.id)).toEqual([plannerWorkItemId, workItemId]);
    expect(workItems.workItems[0]?.source).toBe("planner");
    expect(workItems.workItems[0]?.runnerKind).toBe("local_relay");
    expect(workItems.workItems[0]?.repository).toBe("parallel-agent-runtime");
    expect(mockClient.from).not.toHaveBeenCalledWith("task");
  });

  it("deletes a plan and its work items without touching the task table", async () => {
    const result = await deletePlanForWorkspace(workspaceId, planId);

    expect(result.deleted).toBe(true);
    expect(tables.plan).toHaveLength(1);
    expect(tables.work_items).toHaveLength(1);
    expect(tables.work_items[0]?.workspace_id).toBe(otherWorkspaceId);
    expect(tables.task).toHaveLength(1);
    expect(mockClient.from).not.toHaveBeenCalledWith("task");
  });

  it("deletes a single work item without touching the task table", async () => {
    const result = await deleteWorkItemForWorkspace(workspaceId, workItemId);

    expect(result.deleted).toBe(true);
    expect(tables.work_items).toHaveLength(2);
    expect(tables.work_items.map((workItem) => workItem.id)).not.toContain(workItemId);
    expect(tables.task).toHaveLength(1);
    expect(mockClient.from).not.toHaveBeenCalledWith("task");
  });
});
