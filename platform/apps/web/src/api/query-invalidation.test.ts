import { describe, expect, it, vi } from "vitest";
import {
  invalidateQueryTargets,
  invalidationTargetsForReason,
} from "./query-invalidation";
import { queryKeys } from "./query-keys";

describe("queryKeys", () => {
  it("normalizes unordered dashboard task run ids", () => {
    expect(
      queryKeys.agentDashboard.tasks("agent-1", ["run-b", "run-a"]),
    ).toEqual(queryKeys.agentDashboard.tasks("agent-1", ["run-a", "run-b"]));
  });

  it("uses object scopes for scoped query keys", () => {
    expect(queryKeys.tools.agent("agent-1", "workspace-1")).toEqual([
      "tools",
      "agent",
      { agentId: "agent-1", workspaceId: "workspace-1" },
    ]);
  });
});

describe("invalidationTargetsForReason", () => {
  it("targets all visible readiness surfaces after credential changes", () => {
    const targets = invalidationTargetsForReason("credential", {
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: queryKeys.credentials.all }),
        expect.objectContaining({ key: queryKeys.agents.list("workspace-1") }),
        expect.objectContaining({ key: queryKeys.setup.byAgent("agent-1") }),
        expect.objectContaining({
          key: queryKeys.agentHealth.detail("agent-1"),
        }),
      ]),
    );
  });

  it("deduplicates before calling React Query", async () => {
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    };

    await invalidateQueryTargets(queryClient as never, [
      { key: queryKeys.plans.list("workspace-1"), exact: true },
      { key: queryKeys.plans.list("workspace-1"), exact: true },
    ]);

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.plans.list("workspace-1"),
      exact: true,
    });
  });
});
