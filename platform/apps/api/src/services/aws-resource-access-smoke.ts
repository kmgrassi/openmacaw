import {
  AwsResourceAccessSmokeResponseSchema,
  type AwsResourceAccessSmokeResponse,
} from "../../../../contracts/aws-resource-access-smoke.js";

const SECRET_PATTERNS = [/api[_-]?key\s*[:=]/i, /token\s*[:=]/i, /secret\s*[:=]/i, /(^|[^a-z])sk-[a-z0-9-]{6,}/i];

function assertNoSecrets(payload: AwsResourceAccessSmokeResponse) {
  const serialized = JSON.stringify(payload);
  const leaked = SECRET_PATTERNS.find((pattern) => pattern.test(serialized));
  if (leaked) {
    throw new Error(`AWS resource access smoke payload contains secret-like text: ${leaked}`);
  }
}

export function buildAwsResourceAccessSmokeHarness(): AwsResourceAccessSmokeResponse {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const runId = "run-pr8-smoke";
  const sessionId = "session-pr8-smoke";
  const artifactPrefix = `s3://symphony-dev-container-artifacts/container/workspaces/${workspaceId}/runs/${runId}/`;
  const commandLogUri = `${artifactPrefix}command-logs/pnpm_test.log`;
  const patchArtifactUri = `${artifactPrefix}final/final.diff`;

  const response = AwsResourceAccessSmokeResponseSchema.parse({
    scenario: "container-execution-e1-handoff",
    liveAwsCalls: false,
    workspaceId,
    agentId,
    runId,
    sessionId,
    resources: [
      {
        resourceId: "33333333-3333-4333-8333-333333333333",
        resourceType: "git_repository",
        alias: "parallel-agent-platform",
        providerUrl: "https://github.com/example/parallel-agent-platform",
        accessMode: "read",
        ref: "refs/heads/main",
      },
      {
        resourceId: "44444444-4444-4444-8444-444444444444",
        resourceType: "git_repository",
        alias: "parallel-agent-runtime",
        providerUrl: "https://github.com/example/parallel-agent-runtime",
        accessMode: "read",
        ref: "refs/heads/main",
      },
    ],
    artifactPrefix,
    artifacts: [
      {
        kind: "summary",
        uri: `${artifactPrefix}summary.json`,
        contentType: "application/json",
        sizeBytes: 624,
        sha256: "fixture-summary-sha256",
      },
      {
        kind: "command_log",
        uri: commandLogUri,
        contentType: "text/plain; charset=utf-8",
        sizeBytes: 1820,
        sha256: "fixture-command-log-sha256",
      },
      {
        kind: "patch",
        uri: patchArtifactUri,
        contentType: "text/x-diff",
        sizeBytes: 412,
        sha256: "fixture-patch-sha256",
      },
    ],
    commandSummary: [
      {
        command: "git diff --stat",
        status: "completed",
        exitCode: 0,
        durationMs: 184,
        artifactUri: commandLogUri,
      },
      {
        command: "pnpm test -- --runInBand",
        status: "completed",
        exitCode: 0,
        durationMs: 4238,
        artifactUri: commandLogUri,
      },
    ],
    filesChanged: [
      {
        path: "platform/apps/api/src/services/runtime-dispatch-context.ts",
        status: "modified",
        additions: 18,
        deletions: 4,
      },
      {
        path: "runtime/apps/orchestrator/lib/symphony_elixir/runner/artifacts.ex",
        status: "modified",
        additions: 12,
        deletions: 6,
      },
    ],
    failures: [
      {
        phase: "clone",
        code: "repository_ref_not_found",
        message: "Example structured failure shown to Platform when Runtime cannot clone the requested ref.",
        retryable: false,
        artifactUri: `${artifactPrefix}diagnostics/clone-failure.json`,
      },
    ],
    reviewHandoff: {
      mode: "patch_artifact",
      patchArtifactUri,
      branchName: "codex/aws-resource-access-pr8-smoke",
    },
    smokeSteps: [
      {
        name: "task_launch",
        status: "passed",
        evidence: "Runtime accepted a container dispatch and recorded ECS task identity.",
      },
      {
        name: "secret_resolution",
        status: "passed",
        evidence: "Credential reference resolved without returning credential material to Platform.",
      },
      {
        name: "clone",
        status: "passed",
        evidence: "Repository resources materialized at deterministic aliases.",
      },
      {
        name: "egress",
        status: "passed",
        evidence: "Allowed Git host and AWS endpoints reachable; denied host emits a metric.",
      },
      {
        name: "artifact_write",
        status: "passed",
        evidence: "Summary, command log, and patch artifacts written under the run prefix.",
        artifactUri: `${artifactPrefix}summary.json`,
      },
      {
        name: "cleanup",
        status: "passed",
        evidence: "Task-local workspace cleanup reported through Runtime.",
      },
      {
        name: "review_handoff",
        status: "passed",
        evidence: "Final diff is available as a reviewable patch artifact.",
        artifactUri: patchArtifactUri,
      },
    ],
  });

  assertNoSecrets(response);
  return response;
}
