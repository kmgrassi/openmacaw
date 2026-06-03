import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledTaskProjection } from "../../../../contracts/scheduled-tasks.js";
import { distillWorkspaceSkills } from "./learning/distiller.js";
import { computeScheduledTaskNextRunAt } from "./scheduled-tasks/schedule-calculator.js";
import { dispatchScheduledTaskDelivery } from "./scheduled-tasks.js";

const { logEvent } = vi.hoisted(() => ({
  logEvent: vi.fn(),
}));
const { reflectRunToMemories } = vi.hoisted(() => ({
  reflectRunToMemories: vi.fn(),
}));
vi.mock("../logger.js", () => ({
  logEvent: (event: unknown) => logEvent(event),
}));
vi.mock("./learning/reflector.js", () => ({
  reflectRunToMemories,
}));

vi.mock("./learning/distiller.js", () => ({
  distillWorkspaceSkills: vi.fn(),
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

function scheduledTask(delivery: ScheduledTaskProjection["delivery"]): ScheduledTaskProjection {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId,
    agentId,
    sourceWorkItemId: null,
    createdByUserId: null,
    title: "Scheduled work",
    instructions: "Run the scheduled work.",
    enabled: true,
    schedule: { kind: "every", interval: 1, unit: "day", at: "03:00" },
    timezone: "Etc/UTC",
    nextRunAt: "2026-05-18T03:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    delivery,
    metadata: {},
    createdAt: "2026-05-17T12:00:00.000Z",
    updatedAt: "2026-05-17T12:00:00.000Z",
  };
}

describe("computeScheduledTaskNextRunAt", () => {
  beforeEach(() => {
    vi.mocked(distillWorkspaceSkills).mockReset();
    logEvent.mockReset();
  });

  it("computes an hourly schedule from the current instant", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "every", interval: 1, unit: "hour" },
        "Etc/UTC",
        new Date("2026-05-14T12:30:00.000Z"),
      ),
    ).toBe("2026-05-14T13:30:00.000Z");
  });

  it("computes the next daily wall-clock time in the requested timezone", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "every", interval: 1, unit: "day", at: "09:00" },
        "America/New_York",
        new Date("2026-05-14T12:30:00.000Z"),
      ),
    ).toBe("2026-05-14T13:00:00.000Z");
  });

  it("rolls daily wall-clock schedules forward when today's time already passed", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "every", interval: 1, unit: "day", at: "09:00" },
        "America/New_York",
        new Date("2026-05-14T14:30:00.000Z"),
      ),
    ).toBe("2026-05-15T13:00:00.000Z");
  });

  it("computes every-three-weeks schedules", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "every", interval: 3, unit: "week" },
        "Etc/UTC",
        new Date("2026-05-14T12:30:00.000Z"),
      ),
    ).toBe("2026-06-04T12:30:00.000Z");
  });

  it("computes the next five-field cron occurrence", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "cron", expression: "0 9 * * 1", timezone: "America/New_York" },
        "Etc/UTC",
        new Date("2026-05-14T12:30:00.000Z"),
      ),
    ).toBe("2026-05-18T13:00:00.000Z");
  });
});

describe("dispatchScheduledTaskDelivery", () => {
  beforeEach(() => {
    reflectRunToMemories.mockReset();
    vi.mocked(distillWorkspaceSkills).mockReset();
    logEvent.mockReset();
  });

  it("routes scheduled agent messages to the existing delivery path", async () => {
    await expect(
      dispatchScheduledTaskDelivery(
        scheduledTask({ kind: "scheduled_agent_message", sessionStrategy: "scheduled_task" }),
      ),
    ).resolves.toEqual({ kind: "scheduled_agent_message", status: "not_handled" });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("routes learning reflection jobs to the reflector", async () => {
    reflectRunToMemories.mockResolvedValueOnce({
      sourceRunId: "run-123",
      workspaceId,
      agentId,
      candidatesGenerated: 1,
      memoriesWritten: 1,
      memoryIds: ["memory-1"],
    });

    await expect(
      dispatchScheduledTaskDelivery(
        scheduledTask({
          kind: "learning_reflection",
          sourceRunId: "run-123",
          sourceTaskId: "task-456",
        }),
      ),
    ).resolves.toEqual({
      kind: "learning_reflection",
      status: "completed",
      result: {
        sourceRunId: "run-123",
        workspaceId,
        agentId,
        candidatesGenerated: 1,
        memoriesWritten: 1,
        memoryIds: ["memory-1"],
      },
    });

    expect(reflectRunToMemories).toHaveBeenCalledWith({
      sourceRunId: "run-123",
      sourceTaskId: "task-456",
    });
  });

  it("dispatches learning distillation deliveries to the distiller", async () => {
    vi.mocked(distillWorkspaceSkills).mockResolvedValue({
      workspaceId,
      consideredMemoryCount: 2,
      clusterCount: 1,
      candidateCount: 1,
      candidateMemoryIds: ["44444444-4444-4444-8444-444444444444"],
    });

    await expect(
      dispatchScheduledTaskDelivery(scheduledTask({ kind: "learning_distillation", windowDays: 14 })),
    ).resolves.toEqual({
      kind: "learning_distillation",
      status: "completed",
      workspaceId,
      consideredMemoryCount: 2,
      clusterCount: 1,
      candidateCount: 1,
      candidateMemoryIds: ["44444444-4444-4444-8444-444444444444"],
    });
    expect(distillWorkspaceSkills).toHaveBeenCalledWith(workspaceId, 14);
  });
});
