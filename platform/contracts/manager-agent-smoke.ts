import { z } from "zod";

export const ManagerSmokeStatusSchema = z.enum([
  "not_created",
  "idle_awaiting_credential",
  "not_running",
  "running",
  "unhealthy",
  "error",
]);

export const ManagerSmokeEventSchema = z.object({
  phase: z.enum([
    "login_bootstrap",
    "credential_attached",
    "work_item_due",
    "manager_turn_completed",
    "status_updated",
  ]),
  status: ManagerSmokeStatusSchema,
  message: z.string(),
});

export const ManagerAgentSmokeResponseSchema = z.object({
  scenario: z.literal("manager-agent-end-to-end"),
  liveProviderCalls: z.literal(false),
  workspace: z.object({
    id: z.string(),
    bootstrappedAgents: z.array(z.enum(["planning", "coding", "manager"])),
  }),
  manager: z.object({
    agentId: z.string(),
    provider: z.string(),
    model: z.string(),
    runnerKind: z.literal("llm_tool_runner"),
    credentialRef: z.object({
      type: z.literal("alias"),
      value: z.string(),
    }),
  }),
  workItem: z.object({
    id: z.string(),
    state: z.literal("ready"),
    due: z.literal(true),
  }),
  statusTimeline: z.array(
    z.object({
      status: ManagerSmokeStatusSchema,
      lastTickAt: z.string().nullable(),
      lastDecisionCount: z.number().int().nullable(),
      missing: z.array(z.string()),
      error: z.string().nullable(),
    }),
  ),
  events: z.array(ManagerSmokeEventSchema),
  localFlow: z.array(z.string()),
});

export type ManagerAgentSmokeResponse = z.infer<typeof ManagerAgentSmokeResponseSchema>;
