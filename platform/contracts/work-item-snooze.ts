import { z } from "zod";

import { WorkItemProjectionSchema } from "./work-items.js";

export const SnoozeWorkItemRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    workItemId: z.string().uuid(),
    until: z.string().datetime().optional(),
    seconds: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 24 * 365)
      .optional(),
    indefinite: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (value) =>
      [value.until, value.seconds, value.indefinite === true].filter(Boolean)
        .length === 1,
    { message: "Exactly one of until, seconds, or indefinite is required" },
  );

export const WakeWorkItemRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  workItemId: z.string().uuid(),
});

export const SnoozeWorkItemResponseSchema = z.object({
  workItem: WorkItemProjectionSchema,
});

export type SnoozeWorkItemRequest = z.infer<typeof SnoozeWorkItemRequestSchema>;
export type WakeWorkItemRequest = z.infer<typeof WakeWorkItemRequestSchema>;
export type SnoozeWorkItemResponse = z.infer<
  typeof SnoozeWorkItemResponseSchema
>;
