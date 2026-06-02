import { describe, expect, it, vi } from "vitest";

import { rollupLearningCost } from "./learning-cost.js";
import type { LearningBrokerRunRow, LearningBrokerTaskRow } from "../repositories/learning-cost.js";

const createdAt = "2026-05-18T14:00:00.000Z";

function run(overrides: Partial<LearningBrokerRunRow> = {}): LearningBrokerRunRow {
  return {
    run_id: "run-1",
    workspace_id: "workspace-1",
    created_at: createdAt,
    metadata: {},
    session_thread_id: null,
    ...overrides,
  };
}

function task(overrides: Partial<LearningBrokerTaskRow> = {}): LearningBrokerTaskRow {
  return {
    task_id: "task-1",
    run_id: "run-1",
    type: "learning_reflection",
    created_at: createdAt,
    input_tokens: 100,
    output_tokens: 25,
    total_tokens: 125,
    last_event: null,
    ...overrides,
  };
}

describe("rollupLearningCost", () => {
  it("aggregates learning tasks by kind and day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T15:00:00.000Z"));

    const result = rollupLearningCost({
      startDate: "2026-05-17",
      endDate: "2026-05-18",
      runs: [
        run({ run_id: "run-1", metadata: { learning: { costUsd: 0.01 } } }),
        run({ run_id: "run-2", metadata: { cost_usd: 0.02 } }),
      ],
      tasks: [
        task({ task_id: "reflection-1", run_id: "run-1", type: "learning_reflection" }),
        task({
          task_id: "retrieval-1",
          run_id: "run-1",
          type: "memory.search",
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15,
          last_event: JSON.stringify({ usage: { total_cost: 0.001 } }),
        }),
        task({
          task_id: "distillation-1",
          run_id: "run-2",
          type: "learning_distillation",
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
        }),
      ],
    });

    expect(result).toMatchObject({
      updatedAt: Date.parse("2026-05-18T15:00:00.000Z"),
      totals: {
        inputTokens: 312,
        outputTokens: 108,
        totalTokens: 420,
        totalCost: 0.031,
      },
      aggregates: {
        byKind: [
          { kind: "distillation", taskCount: 1, runCount: 1 },
          { kind: "reflection", taskCount: 1, runCount: 1 },
          { kind: "retrieval", taskCount: 1, runCount: 1 },
        ],
        daily: [
          {
            date: "2026-05-18",
            taskCount: 3,
            runCount: 2,
            totals: { totalTokens: 420, totalCost: 0.031 },
          },
        ],
      },
    });

    vi.useRealTimers();
  });

  it("ignores non-learning rows and tasks without visible runs", () => {
    const result = rollupLearningCost({
      startDate: "2026-05-18",
      endDate: "2026-05-18",
      runs: [run()],
      tasks: [task({ type: "turn" }), task({ run_id: "missing-run", type: "learning_reflection" })],
    });

    expect(result.totals.totalTokens).toBe(0);
    expect(result.aggregates.byKind).toEqual([]);
    expect(result.aggregates.daily).toEqual([]);
  });
});
