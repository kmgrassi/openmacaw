import { describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_MEMORY_BUDGET, workspaceMemoryBudget } from "./memory-budget.js";

describe("workspaceMemoryBudget", () => {
  it("reads the snake_case workspace learning memory budget", () => {
    expect(workspaceMemoryBudget({ learning: { memory_budget: 25 } })).toBe(25);
  });

  it("accepts camelCase settings when an API-layer caller already converted them", () => {
    expect(workspaceMemoryBudget({ learning: { memoryBudget: 30 } })).toBe(30);
  });

  it("falls back to the default for missing or invalid settings", () => {
    expect(workspaceMemoryBudget(undefined)).toBe(DEFAULT_WORKSPACE_MEMORY_BUDGET);
    expect(workspaceMemoryBudget({ learning: { memory_budget: 0 } })).toBe(DEFAULT_WORKSPACE_MEMORY_BUDGET);
  });
});
