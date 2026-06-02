# Production Container Tool Execution Scope

This document scopes the production/cloud execution path for coding tools. It is
separate from the local-model filesystem tooling scope because production
execution is an infrastructure project, not just a model/tool schema project.

The production path should reuse the same model-facing tools as the local helper
path:

- `shell.exec` remains the read/inspect/run tool.
- `apply_patch` remains the edit tool.

The difference is execution placement. Instead of delegating tool execution to a
developer laptop helper, Runtime schedules an isolated container, prepares a
workspace, executes tools inside the container boundary, persists
artifacts/events, and tears the container down when the run completes.

## Goals

- Run coding-agent filesystem and shell tools in an isolated cloud environment.
- Keep Platform API out of direct shell/filesystem execution.
- Reuse the local-helper tool schemas and event/result shapes where possible.
- Make container lifecycle, workspace state, secrets, network policy, and
  artifacts explicit and reviewable.

## Non-Goals

- Do not block the local-helper MVP on production containers.
- Do not expose a general shell service from Platform API.
- Do not assume production containers can use the user's local uncommitted
  files unless a workspace snapshot/upload feature exists.
- Do not design a full multi-tenant compute platform in one PR.

## AWS Architecture Sketch

Recommended first shape:

```text
Platform API
  -> Runtime / Orchestrator
  -> Execution scheduler
  -> ECS/Fargate task per run or short-lived session
  -> Workspace checkout or mounted volume
  -> Tool executor process
  -> Events/logs/artifacts back to Platform
```

Candidate AWS components:

| Component | Role |
|---|---|
| ECS on Fargate | Starts isolated execution tasks without managing EC2 capacity. |
| ECR | Stores the coding execution image. |
| S3 | Stores final diffs, logs, generated artifacts, and optional workspace snapshots. |
| CloudWatch Logs | Captures container lifecycle logs and executor diagnostics. |
| Secrets Manager or SSM Parameter Store | Injects approved Git/provider/package secrets. |
| VPC, private subnets, security groups | Controls network boundary for execution tasks. |
| NAT Gateway or VPC endpoints | Provides controlled outbound access for package installs and repository fetches. |
| SQS or EventBridge | Decouples execution requests, retries, cancellation, and scheduling. |
| Platform DB | Persists run state, tool calls, approval state, artifact references, and final status. |

Fargate is the simplest default. If workloads need cheaper warm capacity,
privileged capabilities, larger workspaces, or longer-lived sessions, a later PR
can evaluate ECS on EC2, AWS Batch, or a purpose-built worker pool.

## Execution Flow

1. Platform resolves the agent, workspace, repository, branch/ref, tools, and
   execution profile.
2. Runtime creates an execution request with resource limits and policy.
3. Scheduler launches an ECS/Fargate task with the coding executor image.
4. The task checks out the repository or restores a workspace snapshot.
5. Runtime sends model-emitted `shell.exec` and `apply_patch` calls to the
   container executor.
6. The executor runs commands or applies patches inside the container workspace.
7. The executor streams command and patch events back to Runtime/Platform.
8. Final diffs, logs, and artifacts are uploaded to S3.
9. Platform can create a branch/PR or expose the patch for review.
10. Runtime stops the task and cleans up temporary volumes.

## Container Lifetime Options

| Option | Tradeoff |
|---|---|
| Per-turn container | Strong isolation, highest cold-start/check-out cost. |
| Per-run container | Good isolation and simple cleanup; good first production default for async jobs. |
| Short-lived per-session container | Better interactive UX and warm dependencies; requires heartbeat, idle timeout, and cleanup. |
| Long-lived workspace container | Fastest repeat use; highest operational and security complexity. |

Recommended first implementation: per-run containers for asynchronous coding
jobs, with an explicit path to short-lived per-session containers for
interactive coding.

## Required PRs

### Production PR 1: Container Execution Contract

Branch suggestion: `codex/container-tool-execution-contract`

Infrastructure prerequisite: none. This PR is pure application contract work.

Responsibilities:

- Define a Runtime execution target for container-backed coding tools.
- Reuse the `shell.exec` and `apply_patch` schemas from the local-helper path.
- Add dispatch metadata for repository source, branch/ref, workspace ID,
  session ID, limits, artifact retention, and network policy.
- Normalize local-helper and container tool results to the same event/result
  shape.

Acceptance criteria:

- Platform can route a coding run to either local-helper execution or
  container-backed execution without changing the model tool schema.
- Runtime can reject a run before model execution when no valid execution target
  is available.
- Tool events from containers render through the same Platform UI path as local
  helper events.

### Production PR 2: Workspace Bootstrap and Isolation

Branch suggestion: `codex/container-workspace-bootstrap`

Infrastructure prerequisite: **Terraform PR 1 (Foundation)** and
**Terraform PR 2 (Execution Stack)** must be merged and applied to the
target environment before this PR is testable end-to-end.

Responsibilities:

- Provision an isolated container for a coding session or run.
- Clone or mount the requested repository at the requested branch/ref.
- Inject only approved secrets and environment variables.
- Enforce CPU, memory, network, disk, timeout, and process limits.
- Clean up containers and temporary volumes after completion.

Acceptance criteria:

- A container run starts with the expected repository contents.
- Commands cannot access host paths outside the mounted workspace.
- Secrets are opt-in and do not appear in logs or tool-call persistence.
- Cleanup is reliable after success, failure, timeout, and cancellation.

### Production PR 3: Container Tool Executor

Branch suggestion: `codex/container-coding-tool-executor`

Infrastructure prerequisite: **Terraform PR 3 (Logging)** must be merged
and applied so Firelens log routing and CloudWatch / S3 destinations exist
before the executor starts streaming events.

Responsibilities:

- Execute `shell.exec` inside the container with the same policy semantics as
  local execution: argv input, cwd containment, timeout, output caps,
  cancellation, and env allowlist.
- Execute `apply_patch` inside the container with path safety and structured
  patch validation.
- Stream stdout/stderr and patch events back to Runtime and Platform.
- Capture final file diffs as artifacts or patch summaries.

Acceptance criteria:

- `shell.exec` can read/search/list, inspect git, run tests, and build inside
  the container.
- `apply_patch` edits files inside the mounted workspace and rejects unsafe
  paths.
- Runtime receives identical normalized events from container and helper
  execution.

### Production PR 4: Artifact, Diff, and Review Handoff

Branch suggestion: `codex/container-artifact-review-handoff`

Infrastructure prerequisite: **Terraform PR 4 (Artifacts and
Observability)** must be merged and applied so the artifact bucket, KMS
key, smoke-test schedule, and alarms exist before this PR ships handoff
behavior.

Responsibilities:

- Persist final diffs, logs, command summaries, and generated artifacts.
- Provide a handoff path from container changes to a branch/PR.
- Add retention policy for command output and artifacts.
- Surface failure diagnostics when bootstrap, dependency install, tests, or
  patch application fails.

Acceptance criteria:

- A successful container run can produce a reviewable branch or patch.
- Platform shows which commands ran, which files changed, and where artifacts
  are stored.
- Failed runs preserve enough information for debugging without storing
  unbounded output.

## Terraform PRs

The Terraform work is scoped into its own PR sequence so it can be assigned
to agents independently of the application PRs. Each Terraform PR pairs with
an application PR and must be applied to the target environment before the
paired application PR is testable end-to-end.

These PRs intentionally describe **what infrastructure must exist**, not the
HCL details. The implementing agent decides module structure and resource
arguments within the project's existing Terraform conventions
([apps/api/infra/](apps/api/infra/)).

All Terraform PRs follow the project policy that any change under the infra
directory requires explicit human approval before `apply`.

### Terraform PR 1: Foundation

Branch suggestion: `codex/container-execution-tf-foundation`

Pairs with: prerequisite for application PR 2.

Deliverables:

- Establish a Terraform module layout for container-execution resources
  (location, naming, state backend wiring, per-environment tfvars).
- Provide the network primitives the execution stack will attach to:
  private subnets, route tables, and any VPC endpoints (S3, ECR, Secrets
  Manager, CloudWatch Logs) that don't already exist.
- Provide an ECR repository for the executor image, with image-tag
  immutability and scanning enabled.
- Provide the GitHub Actions OIDC role and IAM policy that lets the
  executor image build pipeline (the workflow itself lives in the
  Runtime repo's RT-PR3) push to ECR on merge to main. The OIDC role
  lives here so the ECR repository and the credential to push to it are
  provisioned together.
- Wire the `pnpm run smoke:container` harness target so subsequent PRs can
  add tests to it without restructuring.

Acceptance criteria:

- `terraform plan` is clean in every environment.
- The ECR repository accepts a push from the OIDC-assumed role using a
  placeholder image.
- VPC endpoints are reachable from a temporary task in the target subnets.

### Terraform PR 2: Execution Stack

Branch suggestion: `codex/container-execution-tf-execution-stack`

Pairs with: application PR 2 (Workspace Bootstrap and Isolation).

Deliverables:

- ECS cluster sized for the expected concurrency.
- Task execution role and per-run task role pattern (the per-run scoping is
  done at runtime via STS; this PR provisions the base roles and trust
  policies).
- Security groups for execution tasks.
- Network Firewall rule group with the deny-all-egress + FQDN allowlist
  policy described in [Network policy](#network-policy).
- Secrets Manager paths and KMS key for workspace/repository/run secrets.
- Step Functions state machine (or equivalent) that owns the
  RunTask → wait → handle-failure → cleanup lifecycle.

Acceptance criteria:

- Runtime can launch a task into the cluster manually and observe it run
  to completion.
- A task with no allowlisted destination cannot reach the public internet;
  a task with an allowlisted destination can.
- Secrets read from Secrets Manager succeed; reads from a different
  workspace's path fail with `AccessDenied`.

### Terraform PR 3: Logging

Branch suggestion: `codex/container-execution-tf-logging`

Pairs with: application PR 3 (Container Tool Executor).

Deliverables:

- CloudWatch log group for executor errors and lifecycle events.
- S3 bucket (or prefix on the artifact bucket) for non-error stdout/stderr,
  with lifecycle rules.
- Firelens / Fluent Bit task-definition configuration that splits log
  streams by severity per the [Logging Strategy](#logging-strategy)
  section.
- IAM permissions for the task execution role to write to both
  destinations.

Acceptance criteria:

- A task that emits both stdout and stderr lands non-error lines in S3 and
  error lines in CloudWatch within the smoke test's latency budget.
- No log line ever appears in both destinations.

### Terraform PR 4: Artifacts and Observability

Branch suggestion: `codex/container-execution-tf-artifacts-observability`

Pairs with: application PR 4 (Artifact, Diff, and Review Handoff).

Deliverables:

- S3 artifact bucket with KMS encryption, lifecycle policy, and
  per-workspace prefix layout.
- IAM policy template for the per-run STS session that scopes write access
  to the run's prefix only.
- EventBridge schedule that runs the smoke test catalog at the intervals
  defined in [Infrastructure Smoke Tests](#infrastructure-smoke-tests).
- CloudWatch alarms (one per smoke test) wired to the existing on-call
  notification channel.
- CloudWatch dashboard for the staged rollout signals (task start latency,
  run duration, exit code distribution, cost per run).

Acceptance criteria:

- A successful run writes its patch to its own S3 prefix and cannot write
  to another run's prefix.
- Each smoke test produces a single pass/fail metric and triggers its
  alarm when forced to fail.

## Security Requirements

- Runtime context owns workspace, repository, run, and session identity.
- Tool arguments must not be allowed to select another workspace or repository.
- Container tasks should run in private subnets with explicit egress policy.
- Secrets must be opt-in per workspace/repository/run and never logged.
- Workspace paths must be contained inside the mounted checkout.
- Resource limits must be enforced at the task/container level and in the tool
  executor.
- Tool failures should return structured tool-result content unless the
  execution target itself is unavailable.

## Resolved Decisions

These were originally open questions; the answers below are now the design
defaults for the first production rollout.

### Container lifetime

Async coding runs use **per-run containers**. The container is created when the
run starts and torn down when the run completes, fails, times out, or is
cancelled.

Interactive coding uses **short-lived per-session containers** with an idle
timeout. The session container is reaped automatically once no tool calls have
been received for the configured idle window. A heartbeat keeps the container
alive while the user is actively iterating.

### Network policy

Default policy is **deny-all egress**, with an explicit FQDN allowlist enforced
by AWS Network Firewall. The base allowlist covers package registries
(npmjs.org, pypi.org, crates.io, etc.), GitHub, and any required Platform/
Runtime endpoints. Workspace-level allowlist extensions are opt-in and
auditable.

VPC endpoints (S3, ECR, Secrets Manager, CloudWatch Logs) keep AWS-internal
traffic off the NAT path.

### Scheduling owner

**Runtime owns scheduling.** Platform API does not call ECS/Fargate directly
and does not maintain task state. Runtime is the boundary that already knows
the execution target (local helper vs. container) and is the natural owner of
the lifecycle (launch, heartbeat, cancel, reap).

### Diff and review handoff

Every successful run **stores the final patch as an artifact in S3**. This is
the durable record of what the agent produced. On success, Platform may
**also push a branch** to the source repository as a UX affordance for review.
The patch artifact is the source of truth; the branch is reproducible from it
if it gets deleted.

### Uncommitted local changes

**Out of scope for v1.** Production container runs operate on committed refs
only (branch, tag, or commit SHA). A workspace-upload feature that snapshots
uncommitted developer changes for cloud execution is a separate scoping
document and is not a blocker for the first production rollout.

## Logging Strategy

To control CloudWatch Logs ingest cost, container tasks use a **Firelens
sidecar (Fluent Bit)** that splits log streams by severity:

- **Non-error logs** (stdout, command output, executor diagnostics) are
  batched and written to **S3** under the run's artifact prefix. They remain
  available for debugging and replay without paying CloudWatch per-GB ingest.
- **Error logs and lifecycle events** (task start/stop failures, executor
  panics, bootstrap failures) are sent to **CloudWatch Logs** so they show up
  in alarms and on-call dashboards.

Tool-call output already persists in the Platform DB through the normal
event/result path, so CloudWatch is intentionally limited to operator-facing
diagnostics.

## Infrastructure Smoke Tests

AWS infrastructure rollouts fail in ways that don't surface until something
real tries to use them: IAM trust policies that look right but block AssumeRole
from the task role, security groups that block egress to a VPC endpoint,
Firelens config that silently drops logs, SQS subscriptions that exist but
have no consumer, etc. Each piece of glue between services gets its own
smoke test, runnable on demand and on a schedule.

### Smoke test catalog

Each test runs against the live environment (dev, staging, prod) and emits a
single pass/fail metric so dashboards and alarms can track them.

| Test | What it proves | Failure signal |
|---|---|---|
| **Task launch** | Orchestrator can `RunTask` a hello-world image, observe `RUNNING`, then `STOPPED (exit 0)`. | ECS, IAM execution role, ECR pull, subnet routing all work. |
| **Log split — non-error** | A task emits a known stdout line; that line appears in the expected S3 prefix within N seconds. | Firelens sidecar config, S3 write IAM, log routing rules. |
| **Log split — error** | A task emits a known stderr line tagged as error; that line appears in CloudWatch Logs. | Firelens severity filter, CloudWatch ingestion. |
| **Egress allow** | A task does `HEAD https://registry.npmjs.org` and gets a 2xx/3xx. | Network Firewall allowlist, NAT/route tables. |
| **Egress deny** | A task does `HEAD https://example.com` and the connection is blocked. | Deny-default policy is actually denying. |
| **Secrets injection** | A task reads a known test secret from Secrets Manager and asserts the value matches; the value does **not** appear in any log stream. | Secrets Manager IAM, env injection, log redaction. |
| **STS scope — positive** | A task reads the test object under its own run's S3 prefix. | Session policy includes the run's prefix. |
| **STS scope — negative** | A task attempts to read an object under a different workspace's S3 prefix and gets `AccessDenied`. | Session policy is genuinely scoped, not wildcarded. |
| **VPC endpoint reachability** | A task with no NAT route can still reach S3, ECR, Secrets Manager, and CloudWatch Logs. | VPC endpoints exist and are attached to the right route tables / security groups. |
| **Queue round-trip** | Runtime publishes a synthetic `run.requested` to SQS; a worker acks it within N seconds. EventBridge routes a synthetic `run.finished` to the registered target. | Queue permissions, consumer health, EventBridge rules. |
| **Cancellation** | Orchestrator calls `StopTask`; the executor receives `SIGTERM`, runs its cleanup hook, and the task exits before the `SIGKILL` deadline. | `stopTimeout` is honored; executor handles SIGTERM. |
| **End-to-end** | A synthetic agent run executes one `shell.exec` and one `apply_patch` against a test repo; the resulting patch artifact lands in S3 and the events render in Platform. | The full path works as a system. |

These run as scheduled CloudWatch / EventBridge jobs (every 5–15 min in
prod) and on demand from a `pnpm run smoke:container` script in the repo
that targets a chosen environment.

## Staged Rollout

Each stage has an explicit go/no-go signal before advancing. No stage skips.

### Stage 0 — Bake only

- Executor image builds and pushes to ECR on merge to main.
- No runtime traffic. No tasks launched.
- **Go signal:** image is signed, scanned (Inspector or equivalent), and
  resolvable by a sample `RunTask` call.

### Stage 1 — Synthetic only

- Smoke test catalog above runs on a schedule against the dev and staging
  environments. No real workspaces routed to containers.
- **Go signal:** every smoke test green for 7 consecutive days; alert noise
  characterized; on-call runbook entry exists for each failure mode.

### Stage 2 — Internal allowlist

- A short list of internal workspace IDs is allowlisted to route coding runs
  to container execution. Local helper remains the default for everyone
  else.
- **Go signal:** ≥ 50 real coding runs across allowlisted workspaces with no
  cross-workspace data exposure, no unbounded cost incidents, P95 task start
  latency within budget.

### Stage 3 — Percentage rollout

- Routing decision uses a per-workspace flag with a configurable percentage
  for non-allowlisted workspaces. Start at 5%, then 25%, then 50%.
- **Go signal at each step:** error rate, cancellation rate, and cost per
  run are within ±20% of the local-helper baseline; no Sev-2+ incidents
  attributed to container path.

### Stage 4 — Default

- Container execution becomes the default for production workspaces. Local
  helper remains supported for explicit per-agent opt-in.
- **Rollback plan:** flip the routing flag back to local-helper-default in
  one config change; no data migration required because runs are
  independent.

## Remaining Open Questions

- Should dependency caches be per-workspace, per-repo, or global?
