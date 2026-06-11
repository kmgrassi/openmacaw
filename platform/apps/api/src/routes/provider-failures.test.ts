import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getServiceRoleSupabase } from "../supabase-client.js";
import type * as SupabaseClient from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerProviderFailureRoutes } from "./provider-failures.js";

vi.mock("../supabase-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SupabaseClient>()),
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

function providerFailureRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `failure-${index}`,
    created_at: `2026-06-11T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
    workspace_id: workspaceId,
    agent_id: null,
    work_item_id: null,
    run_id: null,
    runner_kind: "planner",
    provider: "openai",
    model: "gpt-5",
    error_code: "provider_rate_limited",
    status_code: 429,
    attempt: 1,
    ...overrides,
  };
}

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("provider failure routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        provider_failure: [
          {
            id: "failure-1",
            created_at: "2026-06-11T12:05:00.000Z",
            workspace_id: workspaceId,
            agent_id: "33333333-3333-4333-8333-333333333333",
            work_item_id: null,
            run_id: "run-1",
            runner_kind: "manager",
            provider: "openai",
            model: "gpt-5",
            error_code: "provider_rate_limited",
            status_code: 429,
            attempt: 1,
          },
          {
            id: "failure-2",
            created_at: "2026-06-11T12:00:00.000Z",
            workspace_id: workspaceId,
            agent_id: null,
            work_item_id: null,
            run_id: null,
            runner_kind: "planner",
            provider: "openai",
            model: "gpt-5",
            error_code: "provider_rate_limited",
            status_code: 429,
            attempt: 2,
          },
          {
            id: "failure-3",
            created_at: "2026-06-11T11:55:00.000Z",
            workspace_id: workspaceId,
            agent_id: null,
            work_item_id: "44444444-4444-4444-8444-444444444444",
            run_id: "run-2",
            runner_kind: "planner",
            provider: "anthropic",
            model: "claude-opus-4-7",
            error_code: "provider_overloaded",
            status_code: 503,
            attempt: 1,
          },
        ],
      }) as never,
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerProviderFailureRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("returns recent provider failures and preserves nullable work item context", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/provider-failures/recent?limit=2`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "failure-1",
          workspaceId,
          workItemId: null,
          provider: "openai",
          errorCode: "provider_rate_limited",
        }),
        expect.objectContaining({
          id: "failure-2",
          workspaceId,
          agentId: null,
          runId: null,
          workItemId: null,
          attempt: 2,
        }),
      ],
      nextCursor: "2",
    });
    expect(assertWorkspaceMembership).toHaveBeenCalledWith(userId, workspaceId);
  });

  it("groups provider failures by provider, model, and error code since a timestamp", async () => {
    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/provider-failures/summary?since=2026-06-11T11:50:00.000Z`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      since: "2026-06-11T11:50:00.000Z",
      items: [
        {
          provider: "openai",
          model: "gpt-5",
          errorCode: "provider_rate_limited",
          count: 2,
        },
        {
          provider: "anthropic",
          model: "claude-opus-4-7",
          errorCode: "provider_overloaded",
          count: 1,
        },
      ],
    });
  });

  it("summarizes every row in high-volume failure windows", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        provider_failure: Array.from({ length: 1002 }, (_value, index) => providerFailureRow(index + 1)),
      }) as never,
    );

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/provider-failures/summary?since=2026-06-11T11:50:00.000Z`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      since: "2026-06-11T11:50:00.000Z",
      items: [
        {
          provider: "openai",
          model: "gpt-5",
          errorCode: "provider_rate_limited",
          count: 1002,
        },
      ],
    });
  });

  it("requires workspace membership before reading service-role data", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(
      new Error("Authenticated user is not authorized for the requested workspace"),
    );

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/provider-failures/recent`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "forbidden",
        message: "Authenticated user is not authorized for the requested workspace",
      },
    });
  });

  it("requires a valid summary timestamp", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/provider-failures/summary?since=yesterday`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "since must be an ISO timestamp",
      },
    });
  });
});
