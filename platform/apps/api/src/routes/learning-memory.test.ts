import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerLearningMemoryRoutes } from "./learning-memory.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw error;
    if (!data) return [];
    return Array.isArray(data) ? data : [data];
  },
}));

vi.mock("../logger.js", () => ({
  logEvent: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("learning memory routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.LEARNING_SIDECAR_ENABLED;
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerLearningMemoryRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns learning memory status for a workspace", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspace_members: [{ workspace_id: workspaceId, user_id: userId }],
        workspaces: [],
        memory_items: [
          {
            id: "memory-1",
            workspace_id: workspaceId,
            is_deleted: false,
            embedding: "[0.1,0.2]",
          },
        ],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/learning/memory-status`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId,
      learningEnabled: true,
      hasEmbeddedMemories: true,
    });
  });

  it("honors the learning sidecar kill switch", async () => {
    process.env.LEARNING_SIDECAR_ENABLED = "false";
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspace_members: [{ workspace_id: workspaceId, user_id: userId }],
        workspaces: [],
        memory_items: [
          {
            id: "memory-1",
            workspace_id: workspaceId,
            is_deleted: false,
            embedding: "[0.1,0.2]",
          },
        ],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/learning/memory-status`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      learningEnabled: false,
      hasEmbeddedMemories: true,
    });
  });

  it("accepts provider warning telemetry", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspace_members: [{ workspace_id: workspaceId, user_id: userId }],
        workspaces: [],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/learning/provider-warning-events`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-1",
        workspaceId,
        fromProvider: "openai",
        toProvider: "anthropic",
        action: "confirmed",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("rejects status reads outside the authenticated user's workspace membership", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(
      new Error("Authenticated user is not authorized for the requested workspace"),
    );
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspace_members: [{ workspace_id: workspaceId, user_id: userId }],
        workspaces: [],
        memory_items: [
          {
            id: "memory-1",
            workspace_id: workspaceId,
            is_deleted: false,
            embedding: "[0.1,0.2]",
          },
        ],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/learning/memory-status`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });
});
