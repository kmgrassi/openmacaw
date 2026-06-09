import { z } from "zod";

export const LocalRuntimeAgentRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});

export const LocalRuntimeMachineIdRowSchema = z.object({
  id: z.string(),
});

export const LocalRuntimeMachineRowSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  last_seen_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  runner_kinds: z.array(z.string()),
  advertised_runner_kinds: z.array(z.string()).nullable().default(null),
});

export const LocalRuntimeRoutingRuleRowSchema = z.object({
  id: z.string(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  runner_kind: z.string(),
});

export const LocalRuntimeRoutingRuleListRowSchema = LocalRuntimeRoutingRuleRowSchema.extend({
  name: z.string(),
});

export const RoutingRuleIdRowSchema = z.object({
  rule_id: z.string(),
});

export const RoutingRuleMatchRowSchema = z.object({
  rule_id: z.string(),
  kind: z.string(),
  key: z.string().nullable(),
  value: z.string(),
});

export type LocalRuntimeAgentRow = z.infer<typeof LocalRuntimeAgentRowSchema>;
export type LocalRuntimeMachineRowRecord = z.infer<typeof LocalRuntimeMachineRowSchema>;
export type LocalRuntimeRoutingRuleListRow = z.infer<typeof LocalRuntimeRoutingRuleListRowSchema>;
export type LocalRuntimeRoutingRuleRow = z.infer<typeof LocalRuntimeRoutingRuleRowSchema>;
export type RoutingRuleIdRow = z.infer<typeof RoutingRuleIdRowSchema>;
export type RoutingRuleMatchRowRecord = z.infer<typeof RoutingRuleMatchRowSchema>;
