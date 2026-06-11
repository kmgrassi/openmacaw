import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { registerProviderCutoverRoutes } from "./provider-cutovers.js";

type Row = Record<string, unknown>;
type ProviderCutoverTestTables = {
  workspace_members: Row[];
  work_items: Row[];
  provider_cutover: Row[];
};

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const workItemId = "33333333-3333-4333-8333-333333333333";
const otherWorkItemId = "44444444-4444-4444-8444-444444444444";
const agentId = "55555555-5555-4555-8555-555555555555";

const tables: ProviderCutoverTestTables = {
  workspace_members: [],
  work_items: [],
  provider_cutover: [],
};
const mockClient = createMockSupabaseClient(tables);

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: () => mockClient,
  normalizeSupabaseError: (_context: string, error: unknown) => error,
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: null }>) => {
    const { data } = await query;
    return Array.isArray(data) ? data : data ? [data] : [];
  },
}));

let baseUrl = "";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function resetTables() {
  tables.workspace_members = [{ workspace_id: workspaceId, user_id: userId }];
  tables.work_items = [
    { id: workItemId, workspace_id: workspaceId },
    { id: otherWorkItemId, workspace_id: otherWorkspaceId },
  ];
  tables.provider_cutover = [];
  vi.clearAllMocks();
}

function cutoverRow(overrides: Row = {}) {
  return {
    id: `66666666-6666-4666-8666-${String(tables.provider_cutover.length + 1).padStart(12, "0")}`,
    workspace_id: workspaceId,
    agent_id: agentId,
    work_item_id: workItemId,
    triggered_at: "2026-06-10T12:00:00.000Z",
    from_provider: "openai",
    from_model: "gpt-5",
    from_credential_id: null,
    to_provider: "anthropic",
    to_model: "claude-opus-4-7",
    to_credential_id: null,
    trigger_error_code: "provider_rate_limited",
    trigger_status_code: 429,
    elapsed_ms: 1250,
    outcome: "fallback_succeeded",
    ...overrides,
  };
}

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("provider cutover routes", () => {
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
    registerProviderCutoverRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("persists a runtime audit payload under the work item's workspace", async () => {
    const response = await request(`/api/work-items/${workItemId}/cutovers`, {
      method: "POST",
      body: JSON.stringify({
        agentId,
        triggeredAt: "2026-06-10T12:00:00.000Z",
        fromProvider: "openai",
        fromModel: "gpt-5",
        fromCredentialId: null,
        toProvider: "anthropic",
        toModel: "claude-opus-4-7",
        toCredentialId: null,
        triggerErrorCode: "provider_rate_limited",
        triggerStatusCode: 429,
        elapsedMs: 1250,
        outcome: "fallback_succeeded",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId,
      workItemId,
      agentId,
      fromProvider: "openai",
      toProvider: "anthropic",
      outcome: "fallback_succeeded",
    });
    expect(tables.provider_cutover).toHaveLength(1);
    expect(tables.provider_cutover[0]).toMatchObject({
      workspace_id: workspaceId,
      work_item_id: workItemId,
      trigger_error_code: "provider_rate_limited",
    });
  });

  it("lists cutovers for a single work item", async () => {
    tables.provider_cutover = [
      cutoverRow({ triggered_at: "2026-06-10T12:00:00.000Z" }),
      cutoverRow({
        id: "66666666-6666-4666-8666-000000000002",
        work_item_id: otherWorkItemId,
        workspace_id: otherWorkspaceId,
        triggered_at: "2026-06-10T13:00:00.000Z",
      }),
      cutoverRow({
        id: "66666666-6666-4666-8666-000000000003",
        triggered_at: "2026-06-10T14:00:00.000Z",
        outcome: "escalated_exhausted",
        to_provider: null,
        to_model: null,
      }),
    ];

    const response = await request(`/api/work-items/${workItemId}/cutovers`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        { id: "66666666-6666-4666-8666-000000000003", outcome: "escalated_exhausted" },
        { id: "66666666-6666-4666-8666-000000000001", outcome: "fallback_succeeded" },
      ],
    });
  });

  it("lists recent workspace cutovers with a cursor", async () => {
    tables.provider_cutover = [
      cutoverRow({ id: "66666666-6666-4666-8666-000000000001", triggered_at: "2026-06-10T12:00:00.000Z" }),
      cutoverRow({ id: "66666666-6666-4666-8666-000000000002", triggered_at: "2026-06-10T13:00:00.000Z" }),
      cutoverRow({ id: "66666666-6666-4666-8666-000000000003", triggered_at: "2026-06-10T14:00:00.000Z" }),
      cutoverRow({
        id: "66666666-6666-4666-8666-000000000004",
        workspace_id: otherWorkspaceId,
        work_item_id: otherWorkItemId,
        triggered_at: "2026-06-10T15:00:00.000Z",
      }),
    ];

    const firstPage = await request(`/api/workspaces/${workspaceId}/cutovers/recent?limit=2`);

    expect(firstPage.status).toBe(200);
    const firstPageBody = await firstPage.json();
    expect(firstPageBody).toMatchObject({
      items: [{ id: "66666666-6666-4666-8666-000000000003" }, { id: "66666666-6666-4666-8666-000000000002" }],
      nextCursor: "2026-06-10T13:00:00.000Z",
    });

    const secondPage = await request(
      `/api/workspaces/${workspaceId}/cutovers/recent?limit=2&cursor=${encodeURIComponent(firstPageBody.nextCursor)}`,
    );

    expect(secondPage.status).toBe(200);
    await expect(secondPage.json()).resolves.toMatchObject({
      items: [{ id: "66666666-6666-4666-8666-000000000001" }],
      nextCursor: null,
    });
  });

  it("rejects cutover reads from another workspace", async () => {
    const response = await request(`/api/work-items/${otherWorkItemId}/cutovers`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });
});
