import { z } from "zod";

export const LocalModelCodingRunnerKindSchema = z.literal("local_model_coding");

export const WorkspaceSandboxSchema = z.enum(["read_only", "workspace_write"]);
export const ApprovalPolicySchema = z.enum(["never", "on_request"]);

export const WorkspacePolicySchema = z.object({
  sandbox: WorkspaceSandboxSchema,
  approvalPolicy: ApprovalPolicySchema,
});

export const CapabilityRequirementsSchema = z.object({
  toolCalls: z.boolean(),
  jsonMode: z.boolean(),
});

export const LocalCodingToolSlugSchema = z.enum([
  "repo.read_file",
  "repo.list",
  "repo.search",
  "git.run",
  "shell.exec",
  "apply_patch",
]);

export const ShellExecArgumentsSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().trim().min(1).optional(),
  timeout_ms: z.number().int().min(1000).max(600000).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const ApplyPatchArgumentsSchema = z.object({
  patch: z.string().trim().min(1),
});

export const RepoListArgumentsSchema = z.object({
  path: z.string().trim().optional(),
  max_depth: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

export const RepoReadFileArgumentsSchema = z.object({
  path: z.string().trim().min(1),
  byte_limit: z.number().int().min(1).optional(),
});

export const RepoSearchArgumentsSchema = z.object({
  query: z.string().trim().min(1),
  path: z.string().trim().optional(),
  limit: z.number().int().min(1).optional(),
  snippet_chars: z.number().int().min(40).optional(),
});

export const GitRunArgumentsSchema = z.object({
  command: z.string().trim().min(1),
  cwd: z.string().trim().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
  output_limit_bytes: z.number().int().min(1024).max(256000).optional(),
});

export const LocalCodingToolArgumentsSchema = z.discriminatedUnion("toolSlug", [
  z.object({
    toolSlug: z.literal("repo.read_file"),
    arguments: RepoReadFileArgumentsSchema,
  }),
  z.object({
    toolSlug: z.literal("repo.list"),
    arguments: RepoListArgumentsSchema,
  }),
  z.object({
    toolSlug: z.literal("repo.search"),
    arguments: RepoSearchArgumentsSchema,
  }),
  z.object({
    toolSlug: z.literal("git.run"),
    arguments: GitRunArgumentsSchema,
  }),
  z.object({
    toolSlug: z.literal("shell.exec"),
    arguments: ShellExecArgumentsSchema,
  }),
  z.object({
    toolSlug: z.literal("apply_patch"),
    arguments: ApplyPatchArgumentsSchema,
  }),
]);

export const CommandActionSchema = z.enum([
  "read",
  "list_files",
  "search",
  "unknown",
]);
export const LocalCodingToolStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "approval_required",
  "cancelled",
]);

export const CommandResultPayloadSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  timedOut: z.boolean().optional(),
});

export const FileChangeSchema = z.object({
  path: z.string().trim().min(1),
  changeType: z.enum(["added", "modified", "deleted"]),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

export const ApplyPatchResultPayloadSchema = z.object({
  applied: z.boolean(),
  changes: z.array(FileChangeSchema),
  message: z.string().optional(),
});

export const RepoListEntrySchema = z.object({
  path: z.string().trim().min(1),
  type: z.string().trim().min(1),
  size: z.number().int().nonnegative(),
});

export const RepoListResultPayloadSchema = z.object({
  path: z.string().trim().min(1),
  entries: z.array(RepoListEntrySchema),
});

export const RepoReadFileResultPayloadSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  bytesRead: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const RepoSearchMatchSchema = z.object({
  path: z.string().trim().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  snippet: z.string(),
});

export const RepoSearchResultPayloadSchema = z.object({
  query: z.string().trim().min(1),
  matches: z.array(RepoSearchMatchSchema),
});

export const LocalCodingToolResultPayloadSchema = z.discriminatedUnion(
  "toolSlug",
  [
    z.object({
      toolSlug: z.literal("repo.read_file"),
      status: LocalCodingToolStatusSchema,
      result: RepoReadFileResultPayloadSchema.nullable(),
      errorCode: z.string().trim().min(1).optional(),
    }),
    z.object({
      toolSlug: z.literal("repo.list"),
      status: LocalCodingToolStatusSchema,
      result: RepoListResultPayloadSchema.nullable(),
      errorCode: z.string().trim().min(1).optional(),
    }),
    z.object({
      toolSlug: z.literal("repo.search"),
      status: LocalCodingToolStatusSchema,
      result: RepoSearchResultPayloadSchema.nullable(),
      errorCode: z.string().trim().min(1).optional(),
    }),
    z.object({
      toolSlug: z.literal("git.run"),
      status: LocalCodingToolStatusSchema,
      commandActions: z.array(CommandActionSchema),
      result: CommandResultPayloadSchema.nullable(),
      errorCode: z.string().trim().min(1).optional(),
    }),
    z.object({
      toolSlug: z.literal("shell.exec"),
      status: LocalCodingToolStatusSchema,
      commandActions: z.array(CommandActionSchema),
      result: CommandResultPayloadSchema.nullable(),
      errorCode: z.string().trim().min(1).optional(),
    }),
    z.object({
      toolSlug: z.literal("apply_patch"),
      status: LocalCodingToolStatusSchema,
      result: ApplyPatchResultPayloadSchema.nullable(),
      errorCode: z.string().trim().min(1).optional(),
    }),
  ],
);

export const LocalCodingCommandEventSchema = z.object({
  type: z.enum(["command_started", "command_output", "command_completed"]),
  toolCallId: z.string().trim().min(1),
  command: z.string().trim().min(1),
  action: CommandActionSchema,
  output: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  occurredAt: z.string().datetime().optional(),
});

export const LocalCodingFileChangeEventSchema = z.object({
  type: z.enum([
    "file_change_started",
    "file_change_applied",
    "file_change_failed",
  ]),
  toolCallId: z.string().trim().min(1),
  changes: z.array(FileChangeSchema),
  errorCode: z.string().trim().min(1).optional(),
  occurredAt: z.string().datetime().optional(),
});

export const LocalCodingNormalizedEventSchema = z.discriminatedUnion("type", [
  LocalCodingCommandEventSchema,
  LocalCodingFileChangeEventSchema,
]);

export const ToolExecutionSourceSchema = z.enum(["local_helper", "container"]);

export const LocalCodingToolResultEnvelopeSchema = z.object({
  source: ToolExecutionSourceSchema,
  payload: LocalCodingToolResultPayloadSchema,
});

export const LocalCodingEventEnvelopeSchema = z.object({
  source: ToolExecutionSourceSchema,
  payload: LocalCodingNormalizedEventSchema,
});

export type LocalModelCodingRunnerKind = z.infer<
  typeof LocalModelCodingRunnerKindSchema
>;
export type WorkspaceSandbox = z.infer<typeof WorkspaceSandboxSchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>;
export type CapabilityRequirements = z.infer<
  typeof CapabilityRequirementsSchema
>;
export type LocalCodingToolSlug = z.infer<typeof LocalCodingToolSlugSchema>;
export type ShellExecArguments = z.infer<typeof ShellExecArgumentsSchema>;
export type ApplyPatchArguments = z.infer<typeof ApplyPatchArgumentsSchema>;
export type RepoListArguments = z.infer<typeof RepoListArgumentsSchema>;
export type RepoReadFileArguments = z.infer<typeof RepoReadFileArgumentsSchema>;
export type RepoSearchArguments = z.infer<typeof RepoSearchArgumentsSchema>;
export type LocalCodingToolArguments = z.infer<
  typeof LocalCodingToolArgumentsSchema
>;
export type CommandAction = z.infer<typeof CommandActionSchema>;
export type LocalCodingToolStatus = z.infer<typeof LocalCodingToolStatusSchema>;
export type CommandResultPayload = z.infer<typeof CommandResultPayloadSchema>;
export type FileChange = z.infer<typeof FileChangeSchema>;
export type ApplyPatchResultPayload = z.infer<
  typeof ApplyPatchResultPayloadSchema
>;
export type RepoListEntry = z.infer<typeof RepoListEntrySchema>;
export type RepoListResultPayload = z.infer<typeof RepoListResultPayloadSchema>;
export type RepoReadFileResultPayload = z.infer<
  typeof RepoReadFileResultPayloadSchema
>;
export type RepoSearchMatch = z.infer<typeof RepoSearchMatchSchema>;
export type RepoSearchResultPayload = z.infer<
  typeof RepoSearchResultPayloadSchema
>;
export type LocalCodingToolResultPayload = z.infer<
  typeof LocalCodingToolResultPayloadSchema
>;
export type LocalCodingNormalizedEvent = z.infer<
  typeof LocalCodingNormalizedEventSchema
>;
export type ToolExecutionSource = z.infer<typeof ToolExecutionSourceSchema>;
export type LocalCodingToolResultEnvelope = z.infer<
  typeof LocalCodingToolResultEnvelopeSchema
>;
export type LocalCodingEventEnvelope = z.infer<
  typeof LocalCodingEventEnvelopeSchema
>;
