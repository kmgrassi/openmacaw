import { z } from "zod";

export const PlannerLocalModelSmokePhaseSchema = z.enum([
  "demo_planner_profile_seeded",
  "diagnostic_verified_local_route",
  "runtime_dispatch_accepted",
  "planner_tool_bundle_loaded",
  "plan_created",
  "tasks_created",
  "work_item_created",
  "latency_recorded",
]);

export const PlannerLocalModelSmokeToolCallSchema = z.object({
  id: z.string(),
  toolSlug: z.enum(["plan.create", "task.create", "task.update"]),
  status: z.enum(["queued", "running", "completed", "failed"]),
  arguments: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
});

export const PlannerLocalModelSmokeResponseSchema = z.object({
  scenario: z.literal("planner-local-model-end-to-end"),
  liveProviderCalls: z.literal(false),
  profile: z.object({
    role: z.literal("planning"),
    runnerKind: z.literal("local_relay"),
    provider: z.literal("local"),
    model: z.string(),
    credentialRef: z.null(),
    toolProfile: z.literal("planning"),
    capabilities: z.object({
      streaming: z.literal(true),
      toolCalls: z.literal(false),
      workspaceWrite: z.literal(false),
      structuredOutput: z.literal(false),
      interrupt: z.literal(false),
    }),
  }),
  diagnostic: z.object({
    endpoint: z.string(),
    resolved: z.literal(true),
    localRuntime: z.object({
      isLocal: z.literal(true),
      expectedRunnerKind: z.literal("local_relay"),
      helperConnectivityRequired: z.literal(true),
    }),
  }),
  plannerOutput: z.object({
    planId: z.string(),
    taskIds: z.array(z.string()).min(1),
    workItem: z.object({
      id: z.string(),
      source: z.literal("planner"),
      state: z.literal("ready"),
      title: z.string(),
    }),
  }),
  latency: z.object({
    observedMs: z.number().int().positive(),
    followUp: z.string(),
  }),
  toolCalls: z.array(PlannerLocalModelSmokeToolCallSchema),
  events: z.array(
    z.object({
      phase: PlannerLocalModelSmokePhaseSchema,
      source: z.enum([
        "platform",
        "runtime",
        "local_model",
        "tool",
        "database",
      ]),
      message: z.string(),
    }),
  ),
  localFlow: z.array(z.string()),
});

export type PlannerLocalModelSmokeResponse = z.infer<
  typeof PlannerLocalModelSmokeResponseSchema
>;
