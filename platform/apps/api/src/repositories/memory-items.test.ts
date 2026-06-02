import { describe, expect, it, vi } from "vitest";

import { MemoryHybridSearchRequestSchema, MemoryWriteRequestSchema } from "../../../../contracts/memory-items.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import {
  getMemoryItem,
  insertMemoryItem,
  listRecentRunSummaryMemories,
  searchMemoryItemsHybrid,
} from "./memory-items.js";

const logEvent = vi.fn();

vi.mock("../logger.js", () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  logEvent: (event: Record<string, unknown>) => logEvent(event),
}));

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

type MockFn = ReturnType<typeof vi.fn>;
type QueryBuilder = {
  eq: MockFn;
  insert: MockFn;
  maybeSingle: MockFn;
  order: MockFn;
  select: MockFn;
  single: MockFn;
  then?: MockFn;
  limit: MockFn;
};

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const now = "2026-05-18T12:00:00.000Z";

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: memoryId,
    workspace_id: workspaceId,
    agent_id: agentId,
    scope: "run_summary",
    content: "Use pnpm for this repo.",
    tags: { source: "test" },
    importance: 8,
    event_time: now,
    source_run_id: "run-1",
    source_task_id: null,
    source_path: null,
    canonical_id: null,
    supersedes_id: null,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function mockBuilder(result: unknown): QueryBuilder {
  const builder: QueryBuilder = {
    eq: vi.fn(),
    insert: vi.fn(),
    maybeSingle: vi.fn(),
    order: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
    limit: vi.fn(),
  };
  builder.eq.mockReturnValue(builder);
  builder.insert.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.maybeSingle.mockResolvedValue(result);
  builder.single.mockResolvedValue(result);
  return builder;
}

function mockThenableCount(count: number): QueryBuilder {
  const builder: QueryBuilder = {
    eq: vi.fn(),
    insert: vi.fn(),
    maybeSingle: vi.fn(),
    order: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((onfulfilled?: (value: { count: number; error: null }) => unknown) =>
      Promise.resolve({ count, error: null }).then(onfulfilled),
    ),
  };
  builder.eq.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return builder;
}

function mockInsertSupabase({
  memoryCount = 0,
  memoryBudget = 5000,
}: {
  memoryCount?: number;
  memoryBudget?: number;
} = {}) {
  const workspaceBuilder = mockBuilder({
    data: {
      id: workspaceId,
      settings: { learning: { memory_budget: memoryBudget } },
    },
    error: null,
  });
  const countBuilder = mockThenableCount(memoryCount);
  const insertBuilder = mockBuilder({ data: memoryRow(), error: null });
  const from = vi.fn((table: string) => {
    if (table === "workspaces") return workspaceBuilder;
    if (
      table === "memory_items" &&
      from.mock.calls.filter(([calledTable]) => calledTable === "memory_items").length === 1
    ) {
      return countBuilder;
    }
    return insertBuilder;
  });
  vi.mocked(getServiceRoleSupabase).mockReturnValue({ from } as never);
  return { from, workspaceBuilder, countBuilder, insertBuilder };
}

describe("memory item contracts", () => {
  it("validates write requests with camelCase API fields", () => {
    expect(
      MemoryWriteRequestSchema.parse({
        workspaceId,
        agentId,
        scope: "long_term",
        content: "Prefer the repository patterns.",
        importance: 9,
        sourceRunId: "run-1",
      }),
    ).toMatchObject({
      workspaceId,
      agentId,
      scope: "long_term",
      content: "Prefer the repository patterns.",
      importance: 9,
      tags: {},
    });
  });

  it("rejects invalid hybrid search limits", () => {
    expect(() =>
      MemoryHybridSearchRequestSchema.parse({
        workspaceId,
        queryText: "repo conventions",
        limit: 51,
      }),
    ).toThrow();
  });
});

describe("memory item repository", () => {
  it("inserts a memory row and maps it to the API shape", async () => {
    const { from, insertBuilder } = mockInsertSupabase();

    const item = await insertMemoryItem({
      workspaceId,
      agentId,
      content: "Use pnpm for this repo.",
      importance: 8,
      sourceRunId: "run-1",
    });

    expect(from).toHaveBeenCalledWith("workspaces");
    expect(from).toHaveBeenCalledWith("memory_items");
    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: workspaceId,
        agent_id: agentId,
        scope: "run_summary",
        content: "Use pnpm for this repo.",
        importance: 8,
        source_run_id: "run-1",
      }),
    );
    expect(item).toMatchObject({
      id: memoryId,
      workspaceId,
      agentId,
      sourceRunId: "run-1",
      isDeleted: false,
    });
  });

  it("rejects inserts that would exceed the workspace memory budget", async () => {
    mockInsertSupabase({ memoryBudget: 1, memoryCount: 1 });

    await expect(
      insertMemoryItem({
        workspaceId,
        agentId,
        content: "Use pnpm for this repo.",
        importance: 8,
        sourceRunId: "run-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "memory_budget_exceeded",
      details: {
        workspaceId,
        memoryBudget: 1,
        memoryCount: 1,
      },
    });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "memory_write_budget_exceeded",
        level: "warn",
        workspace_id: workspaceId,
        source_run_id: "run-1",
        memory_budget: 1,
        memory_count: 1,
      }),
    );
  });

  it("lists recent run-summary memories in API shape", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        memory_items: [memoryRow()],
      }) as never,
    );

    const rows = await listRecentRunSummaryMemories({ workspaceId });

    expect(rows).toEqual([
      expect.objectContaining({
        id: memoryId,
        workspaceId,
        agentId,
        sourceRunId: "run-1",
        tags: { source: "test" },
        isDeleted: false,
      }),
    ]);
  });

  it("loads a visible memory row by id and workspace", async () => {
    const builder = mockBuilder({ data: memoryRow(), error: null });
    vi.mocked(getServiceRoleSupabase).mockReturnValue({ from: vi.fn().mockReturnValue(builder) } as never);

    const item = await getMemoryItem(memoryId, workspaceId);

    expect(builder.eq).toHaveBeenCalledWith("id", memoryId);
    expect(builder.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(builder.eq).toHaveBeenCalledWith("is_deleted", false);
    expect(item?.id).toBe(memoryId);
  });

  it("calls memory_hybrid_search and maps ranked rows", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          id: memoryId,
          workspace_id: workspaceId,
          agent_id: null,
          scope: "long_term",
          content: "Tests require the API validation script.",
          tags: {},
          importance: 9,
          event_time: now,
          source_run_id: null,
          source_task_id: null,
          score: 0.75,
        },
      ],
      error: null,
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue({ rpc } as never);

    const results = await searchMemoryItemsHybrid({
      workspaceId,
      queryText: "validation",
      queryEmbedding: "[0.1,0.2]",
      limit: 3,
    });

    expect(rpc).toHaveBeenCalledWith("memory_hybrid_search", {
      p_workspace_id: workspaceId,
      p_agent_id: null,
      p_scope: null,
      p_query_text: "validation",
      p_query_embedding: "[0.1,0.2]",
      p_match_count: 3,
    });
    expect(results).toEqual([
      expect.objectContaining({
        id: memoryId,
        workspaceId,
        agentId: null,
        scope: "long_term",
        score: 0.75,
      }),
    ]);
  });
});
