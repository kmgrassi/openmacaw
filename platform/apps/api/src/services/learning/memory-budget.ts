import { z } from "zod";

export const DEFAULT_WORKSPACE_MEMORY_BUDGET = 5000;

const LearningSettingsSchema = z
  .object({
    memory_budget: z.number().int().positive().optional(),
    memoryBudget: z.number().int().positive().optional(),
  })
  .passthrough();

const WorkspaceSettingsSchema = z
  .object({
    learning: LearningSettingsSchema.optional(),
  })
  .passthrough();

export function workspaceMemoryBudget(settings: unknown): number {
  const parsed = WorkspaceSettingsSchema.safeParse(settings);
  if (!parsed.success) return DEFAULT_WORKSPACE_MEMORY_BUDGET;

  return parsed.data.learning?.memory_budget ?? parsed.data.learning?.memoryBudget ?? DEFAULT_WORKSPACE_MEMORY_BUDGET;
}
