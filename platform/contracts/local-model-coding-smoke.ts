import { z } from "zod";

export const LocalModelCodingSmokePhaseSchema = z.enum([
  "platform_profile_resolved",
  "runtime_dispatch_accepted",
  "local_model_tool_call",
  "shell_exec_completed",
  "apply_patch_completed",
  "workspace_diff_surfaced",
  "ui_events_ready",
]);

export const LocalModelCodingSmokeToolCallSchema = z.object({
  id: z.string(),
  toolSlug: z.enum(["shell.exec", "apply_patch"]),
  status: z.enum(["queued", "running", "completed", "failed"]),
  commandActions: z.array(z.enum(["read", "list_files", "search", "unknown"])),
  arguments: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
});

export const LocalModelCodingSmokeEventSchema = z.object({
  phase: LocalModelCodingSmokePhaseSchema,
  source: z.enum(["platform", "runtime", "local_model", "tool", "ui"]),
  message: z.string(),
});

export const LocalModelCodingSmokeResponseSchema = z.object({
  scenario: z.literal("local-model-coding-runner-end-to-end"),
  liveProviderCalls: z.literal(false),
  profile: z.object({
    role: z.literal("coding"),
    runnerKind: z.literal("local_model_coding"),
    provider: z.literal("openai_compatible"),
    model: z.string(),
    credentialRef: z.object({
      type: z.literal("alias"),
      value: z.string(),
    }),
    toolProfile: z.literal("coding"),
    workspacePolicy: z.object({
      sandbox: z.literal("workspace-write"),
      approvalPolicy: z.enum(["never", "on-request", "on-failure"]),
    }),
    capabilityRequirements: z.object({
      toolCalls: z.literal(true),
      jsonMode: z.literal(true),
    }),
  }),
  runtimeDispatch: z.object({
    endpoint: z.literal("runtime-local-loopback"),
    accepted: z.literal(true),
    runner: z.literal("local_model_coding"),
  }),
  workspaceMutation: z.object({
    disposableRepo: z.string(),
    changedFile: z.string(),
    before: z.string(),
    after: z.string(),
    diff: z.string(),
  }),
  toolCalls: z.array(LocalModelCodingSmokeToolCallSchema),
  events: z.array(LocalModelCodingSmokeEventSchema),
  browserChecks: z.array(z.string()),
  localFlow: z.array(z.string()),
});

export type LocalModelCodingSmokeResponse = z.infer<
  typeof LocalModelCodingSmokeResponseSchema
>;
