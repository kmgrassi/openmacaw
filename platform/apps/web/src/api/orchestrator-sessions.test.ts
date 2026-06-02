import { describe, expect, it, vi } from "vitest";

import { listOrchestratorSessions } from "./orchestrator-sessions";

describe("listOrchestratorSessions", () => {
  it("requests unknown sessions so durable manager transcripts are not hidden", async () => {
    const request = vi.fn().mockResolvedValue({ sessions: [] });

    await listOrchestratorSessions(request, 25);

    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeGlobal: false,
      includeUnknown: true,
      limit: 25,
    });
  });

  it("preserves manager session rows returned by the gateway", async () => {
    const managerAgentId = "66666666-6666-4666-8666-666666666666";
    const request = vi.fn().mockResolvedValue({
      ts: 1_700_000_000_000,
      count: 1,
      sessions: [
        {
          key: `agent:${managerAgentId}:main`,
          sessionId: "manager-thread",
          agentId: managerAgentId,
          kind: "manager",
          label: "Manager transcript",
          surface: "manager_scheduler",
          updatedAt: 1_700_000_000,
          model: "openai/gpt-5.2",
        },
      ],
    });

    const result = await listOrchestratorSessions(request, 50);

    expect(result.sessions).toEqual([
      expect.objectContaining({
        key: `agent:${managerAgentId}:main`,
        id: "manager-thread",
        sessionId: "manager-thread",
        agentId: managerAgentId,
        kind: "manager",
        label: "Manager transcript",
        surface: "manager_scheduler",
        updatedAt: 1_700_000_000,
        model: "openai/gpt-5.2",
      }),
    ]);
  });
});
