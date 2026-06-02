import { z } from "zod";

import {
  RuntimeArtifactSchema,
  RuntimeFailureSurfaceSchema,
} from "./execution-profile.js";

export const AwsResourceAccessSmokeStepSchema = z.object({
  name: z.enum([
    "task_launch",
    "secret_resolution",
    "clone",
    "egress",
    "artifact_write",
    "cleanup",
    "review_handoff",
  ]),
  status: z.enum(["passed", "failed", "not_run"]),
  evidence: z.string().trim().min(1),
  artifactUri: z.string().trim().min(1).optional(),
});

export const AwsResourceAccessSmokeResponseSchema = z.object({
  scenario: z.literal("aws-resource-access-pr8-handoff"),
  liveAwsCalls: z.literal(false),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  runId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  resources: z.array(
    z.object({
      resourceId: z.string().uuid(),
      resourceType: z.enum(["git_repository", "website", "docs", "api"]),
      alias: z.string().trim().min(1),
      providerUrl: z.string().url(),
      accessMode: z.enum(["read", "write"]),
      ref: z.string().trim().min(1).optional(),
    }),
  ),
  artifactPrefix: z.string().trim().min(1),
  artifacts: z.array(RuntimeArtifactSchema),
  failures: z.array(RuntimeFailureSurfaceSchema),
  reviewHandoff: z.object({
    mode: z.enum(["patch_artifact", "branch_pr"]),
    patchArtifactUri: z.string().trim().min(1),
    branchName: z.string().trim().min(1).optional(),
    pullRequestUrl: z.string().url().optional(),
  }),
  smokeSteps: z.array(AwsResourceAccessSmokeStepSchema),
});

export type AwsResourceAccessSmokeResponse = z.infer<
  typeof AwsResourceAccessSmokeResponseSchema
>;
