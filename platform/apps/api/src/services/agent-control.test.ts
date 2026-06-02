import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SupabaseClientModule from "../supabase-client.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import {
  assertAgentControlAccess,
  createAgentControlMessage,
  createAgentRemediation,
  updateAgentControlMessageDispatchStatus,
} from "./agent-control.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";

vi.mock("../supabase-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SupabaseClientModule>();
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

vi.mock("./work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const mockedGetServiceRoleSupabase = vi.mocked(getServiceRoleSupabase);
const mockedAssertWorkspaceMembership = vi.mocked(assertWorkspaceMembership);

const workspaceId = "22222222-2222-4222-8222-222222222222";
const targetAgentId = "33333333-3333-4333-8333-333333333333";
const observerAgentId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";

describe("agent control services", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedAssertWorkspaceMembership.mockResolvedValue(undefined);
    mockedGetServiceRoleSupabase.mockReturnValue(
      createMockSupabaseClient({
        agent: [
          { id: targetAgentId, workspace_id: workspaceId },
          { id: observerAgentId, workspace_id: workspaceId },
        ],
        agent_control_messages: [],
      }) as never,
    );
  });

  it("requires target and observer agents in the requested workspace", async () => {
    await expect(
      assertAgentControlAccess({
        userId,
        workspaceId,
        targetAgentId,
        observerAgentId,
      }),
    ).resolves.toBeUndefined();

    expect(mockedAssertWorkspaceMembership).toHaveBeenCalledWith(userId, workspaceId);
  });

  it("rejects handoff persistence when the generated schema has no control-message table", async () => {
    await expect(
      createAgentControlMessage({
        workspaceId,
        targetAgentId,
        observerAgentId,
        kind: "handoff",
        subject: "handoff",
        body: "please continue",
        metadata: { plan_id: "plan-1" },
        createdByUserId: userId,
      }),
    ).rejects.toThrow("Agent control messages are not available");
  });

  it("rejects remediation persistence when the generated schema has no control-message table", async () => {
    await expect(
      createAgentRemediation({
        workspaceId,
        targetAgentId,
        observerAgentId,
        action: "restart",
        reason: "stuck",
        metadata: {},
        dispatchStatus: "dispatching",
        createdByUserId: userId,
      }),
    ).rejects.toThrow("Agent control messages are not available");

    await expect(
      updateAgentControlMessageDispatchStatus({
        messageId: "missing-message",
        status: "accepted",
        dispatchStatus: "dispatched",
      }),
    ).resolves.toBeNull();
  });
});
