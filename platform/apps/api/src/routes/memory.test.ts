import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as LoggerModule from "../logger.js";
import { insertMemoryItem } from "../repositories/memory-items.js";
import { registerMemoryRoutes } from "./memory.js";

const logEvent = vi.fn();

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof LoggerModule>("../logger.js");
  return {
    ...actual,
    logEvent: (event: Record<string, unknown>) => logEvent(event),
  };
});

vi.mock("../repositories/memory-items.js", () => ({
  insertMemoryItem: vi.fn(),
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const memoryId = "55555555-5555-4555-8555-555555555555";

let baseUrl = "";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function memoryItem() {
  return {
    id: memoryId,
    workspaceId,
    agentId,
    scope: "run_summary" as const,
    content: "Use pnpm validate before opening PRs.",
    tags: { source: "reflection" },
    importance: 7,
    eventTime: "2026-05-18T12:00:00.000Z",
    sourceRunId: "run-1",
    sourceTaskId: "task-1",
    sourcePath: null,
    canonicalId: null,
    supersedesId: null,
    isDeleted: false,
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-18T12:00:00.000Z",
  };
}

function request(body: unknown, token?: string) {
  return fetch(`${baseUrl}/api/memory/items`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("memory routes", () => {
  let server: Server;

  beforeEach(async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-token";
    logEvent.mockClear();
    vi.mocked(insertMemoryItem).mockReset();
    vi.mocked(insertMemoryItem).mockResolvedValue(memoryItem());

    const app = express();
    app.use(express.json());
    registerMemoryRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("writes a memory item with a service-role bearer token and emits an audit log", async () => {
    const response = await request(
      {
        workspaceId,
        agentId,
        content: "Use pnpm validate before opening PRs.",
        tags: { source: "reflection" },
        importance: 7,
        sourceRunId: "run-1",
        sourceTaskId: "task-1",
      },
      "service-role-token",
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      memoryItem: { id: memoryId, workspaceId, agentId, sourceRunId: "run-1" },
    });
    expect(insertMemoryItem).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        agentId,
        scope: "run_summary",
        importance: 7,
      }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "memory_item_written",
        workspace_id: workspaceId,
        agent_id: agentId,
        memory_id: memoryId,
        source_run_id: "run-1",
        source_task_id: "task-1",
        scope: "run_summary",
        importance: 7,
        byte_count: Buffer.byteLength("Use pnpm validate before opening PRs.", "utf8"),
      }),
    );
  });

  it("rejects unsigned requests", async () => {
    const response = await request({
      workspaceId,
      content: "Use pnpm validate before opening PRs.",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
    expect(insertMemoryItem).not.toHaveBeenCalled();
  });

  it("rejects non-service bearer tokens before writing", async () => {
    const response = await request(
      {
        workspaceId,
        content: "Use pnpm validate before opening PRs.",
      },
      "user-jwt-token",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "service_role_forbidden" },
    });
    expect(insertMemoryItem).not.toHaveBeenCalled();
  });

  it("rejects client-owned lifecycle fields", async () => {
    const response = await request(
      {
        workspaceId,
        content: "Use pnpm validate before opening PRs.",
        createdAt: "2026-05-18T12:00:00.000Z",
        isDeleted: true,
      },
      "service-role-token",
    );

    expect(response.status).toBe(400);
    expect(insertMemoryItem).not.toHaveBeenCalled();
  });
});
