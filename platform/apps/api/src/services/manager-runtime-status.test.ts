import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeLoggedSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";
import { getManagerRuntimeStatus, normalizeManagerRuntimeStatus } from "./manager-runtime-status.js";

vi.mock("../supabase-client.js", () => ({
  executeLoggedSupabaseRows: vi.fn(),
  getServiceRoleSupabase: vi.fn(),
}));

vi.mock("./work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const managerAgentId = "33333333-3333-4333-8333-333333333333";

function queryBuilder() {
  return {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
}

function managerAgent() {
  return {
    id: managerAgentId,
    workspace_id: workspaceId,
    status: "active",
    type: "manager",
    updated_at: "2026-04-27T12:00:00.000Z",
  };
}

describe("manager runtime status service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(getServiceRoleSupabase).mockReturnValue(queryBuilder() as never);
    vi.mocked(executeLoggedSupabaseRows).mockResolvedValue([managerAgent()] as never);
  });

  it("normalizes runtime status payload variants", () => {
    expect(
      normalizeManagerRuntimeStatus(workspaceId, managerAgentId, {
        workspace_id: workspaceId,
        agent_id: managerAgentId,
        status: "idle",
        last_tick_at: "2026-04-27T12:00:00.000Z",
        last_decision_count: 2,
        missing: ["credential"],
      }),
    ).toEqual({
      workspaceId,
      agentId: managerAgentId,
      status: "idle_awaiting_credential",
      lastTickAt: "2026-04-27T12:00:00.000Z",
      lastDecisionCount: 2,
      missing: ["credential"],
      error: null,
    });
  });

  it("returns not_created when the workspace has no manager agent", async () => {
    vi.mocked(executeLoggedSupabaseRows).mockResolvedValue([] as never);

    const status = await getManagerRuntimeStatus({
      workspaceId,
      userId,
      runtimeRequest: vi.fn(),
    });

    expect(status).toMatchObject({
      workspaceId,
      agentId: null,
      status: "not_created",
    });
    expect(executeLoggedSupabaseRows).toHaveBeenCalledWith(
      {
        operation: "manager_runtime_status.find_workspace_manager_agent",
        table: "agent",
      },
      expect.anything(),
    );
  });

  it("proxies manager status after enforcing workspace membership", async () => {
    const runtimeRequest = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        status: "running",
        lastTickAt: "2026-04-27T12:01:00.000Z",
        lastDecisionCount: 4,
      },
    });

    const status = await getManagerRuntimeStatus({ workspaceId, userId, runtimeRequest });

    expect(assertWorkspaceMembership).toHaveBeenCalledWith(userId, workspaceId);
    expect(runtimeRequest).toHaveBeenCalledWith(`/api/runtime/manager-status?workspace_id=${workspaceId}`, {
      method: "GET",
    });
    expect(status).toMatchObject({
      workspaceId,
      agentId: managerAgentId,
      status: "running",
      lastDecisionCount: 4,
    });
  });

  it("returns typed not_running status when runtime is unavailable", async () => {
    const status = await getManagerRuntimeStatus({
      workspaceId,
      userId,
      runtimeRequest: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    });

    expect(status).toMatchObject({
      workspaceId,
      agentId: managerAgentId,
      status: "not_running",
      error: "connect ECONNREFUSED",
    });
  });

  it("rejects users outside the workspace", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValue(
      new Error("Authenticated user is not authorized for the requested workspace"),
    );

    await expect(
      getManagerRuntimeStatus({
        workspaceId,
        userId,
        runtimeRequest: vi.fn(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workspace_forbidden",
    });
  });
});
