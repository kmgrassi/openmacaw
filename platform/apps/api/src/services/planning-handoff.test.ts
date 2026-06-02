import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { assertCodingHandoffReviewable, codingHandoffEnv, parseCodingHandoff } from "./planning-handoff.js";

vi.mock("../supabase-client.js", () => ({
  executeSupabaseRows: vi.fn(),
  getServiceRoleSupabase: vi.fn(),
}));

function queryBuilder() {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    limit: vi.fn(() => builder),
  };
  return builder;
}

describe("planning handoff helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing handoff when required", () => {
    expect(() => parseCodingHandoff({}, true)).toThrow("reviewed plan ID");
  });

  it("allows missing handoff when the route is not an explicit coding handoff", () => {
    expect(parseCodingHandoff({}, false)).toBeNull();
  });

  it("deduplicates selected task IDs", () => {
    expect(
      parseCodingHandoff(
        {
          handoff: {
            planId: "plan-1",
            taskIds: ["task-1", "task-1", "task-2"],
          },
        },
        true,
      ),
    ).toEqual({
      planId: "plan-1",
      taskIds: ["task-1", "task-2"],
    });
  });

  it("projects handoff into worker environment", () => {
    expect(codingHandoffEnv({ planId: "plan-1", taskIds: ["task-1", "task-2"] })).toEqual({
      PLANNER_HANDOFF_APPROVED: "1",
      PLANNER_APPROVED_PLAN_ID: "plan-1",
      PLANNER_APPROVED_TASK_IDS: "task-1,task-2",
    });
  });

  it("validates selected IDs against work_items for the selected plan and workspace", async () => {
    const from = vi.fn(() => queryBuilder());
    vi.mocked(getServiceRoleSupabase).mockReturnValue({ from } as never);
    vi.mocked(executeSupabaseRows).mockImplementation(async (context) => {
      if (context === "plan query") return [{ id: "plan-1", status: "reviewed" }];
      if (context === "work_items query")
        return [{ id: "work-item-1", plan_id: "plan-1", workspace_id: "workspace-1" }];
      return [];
    });

    await expect(
      assertCodingHandoffReviewable({
        workspaceId: "workspace-1",
        handoff: { planId: "plan-1", taskIds: ["work-item-1"] },
      }),
    ).resolves.toBeUndefined();

    expect(from).toHaveBeenCalledWith("plan");
    expect(from).toHaveBeenCalledWith("work_items");
    expect(from).not.toHaveBeenCalledWith("task");
    expect(executeSupabaseRows).toHaveBeenCalledWith("work_items query", expect.anything());
  });
});
