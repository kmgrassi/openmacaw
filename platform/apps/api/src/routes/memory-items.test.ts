import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { registerMemoryItemRoutes } from "./memory-items.js";

type Row = Record<string, unknown>;
type TableRows = Row[];
type MemoryItemTestTables = {
  workspace_members: TableRows;
  workspaces: TableRows;
  memory_items: TableRows;
};

const tables: MemoryItemTestTables = {
  workspace_members: [],
  workspaces: [],
  memory_items: [],
};
const mockClient = createMockSupabaseClient(tables);

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: () => mockClient,
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: null }>) => {
    const { data } = await query;
    return Array.isArray(data) ? data : data ? [data] : [];
  },
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const agentId = "33333333-3333-4333-8333-333333333333";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function memoryRow(overrides: Row = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspace_id: workspaceId,
    agent_id: null,
    scope: "long_term",
    content: "Use pnpm for this repo.",
    importance: 9,
    tags: ["repo"],
    source_run_id: "run-1",
    source_task_id: null,
    source_path: null,
    canonical_id: null,
    supersedes_id: null,
    event_time: "2026-05-01T12:00:00.000Z",
    created_at: "2026-05-01T12:00:00.000Z",
    updated_at: "2026-05-01T12:00:00.000Z",
    is_deleted: false,
    ...overrides,
  };
}

function resetTables() {
  tables.workspace_members = [{ workspace_id: workspaceId, user_id: userId }];
  tables.workspaces = [];
  tables.memory_items = [
    memoryRow(),
    memoryRow({
      id: "55555555-5555-4555-8555-555555555555",
      agent_id: agentId,
      scope: "run_summary",
      content: "Fixed scheduler retry handling.",
      importance: 6,
      source_run_id: "run-2",
      event_time: "2026-05-02T12:00:00.000Z",
    }),
    memoryRow({
      id: "66666666-6666-4666-8666-666666666666",
      workspace_id: otherWorkspaceId,
      content: "Other workspace memory.",
    }),
    memoryRow({
      id: "77777777-7777-4777-8777-777777777777",
      content: "Deleted memory.",
      is_deleted: true,
    }),
  ];
  vi.clearAllMocks();
}

let baseUrl = "";

describe("memory item routes", () => {
  let server: Server;

  beforeEach(async () => {
    resetTables();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerMemoryItemRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("lists non-deleted memory items for an authorized workspace", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/memory-items`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.memoryItems).toHaveLength(2);
    expect(body.memoryItems[0]).toMatchObject({
      id: "55555555-5555-4555-8555-555555555555",
      workspaceId,
      agentId,
      scope: "run_summary",
      sourceRunId: "run-2",
    });
  });

  it("filters by workspace-only owner, scope, importance, and source run", async () => {
    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/memory-items?agentId=&scope=long_term&importanceMin=8&sourceRunId=run-1`,
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.memoryItems).toHaveLength(1);
    expect(body.memoryItems[0]).toMatchObject({ agentId: null, content: "Use pnpm for this repo." });
  });

  it("rejects unauthorized workspace access", async () => {
    tables.workspace_members = [];

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/memory-items`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });
});
