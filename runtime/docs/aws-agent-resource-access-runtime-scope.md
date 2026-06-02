# AWS Agent Resource Access - Runtime Scope

This is the Runtime companion to the Platform scope in
`parallel-agent-platform/docs/active/aws-agent-resource-access-scope.md`.
The Platform document owns the cross-repo rollout and AWS Terraform sequence.
This document owns the Runtime work needed to make cloud planning/coding agents
materialize authorized resources into isolated execution environments.

The first production implementation is AWS/ECS, but Runtime should expose a
provider-neutral execution adapter boundary. AWS is the first adapter behind
that boundary, not the shape of the runtime contract.

Planning sessions must support multiple repositories/resources in one worker.
The AWS adapter should not assume a single `repositorySource` per run. The first
smoke test can clone one repository, but the runtime contract must support a
`resources: [...]` shape with deterministic aliases and per-resource grants
before production planning rollout.

## Current Runtime Support

Runtime already has a local materialization path:

- `apps/orchestrator/lib/symphony_elixir/worker_bridge/repository_manager.ex`
  normalizes repository URLs, maintains a bare mirror cache under
  `SYMPHONY_WORKER_BRIDGE_ROOT/repo-cache`, creates disposable session
  workspaces under `SYMPHONY_WORKER_BRIDGE_ROOT/sessions`, and checks out a
  requested ref.
- `apps/orchestrator/lib/symphony_elixir/worker_bridge/server.ex` starts a
  worker session from `cwd`, a `repository` payload, or workspace/agent identity.
- `docs/production-container-tool-execution-scope.md` already assigns Runtime
  ownership for scheduling, executor lifecycle, and artifact upload in the
  container execution path.

That support is local-process oriented. AWS production execution still needs a
runtime adapter that can launch a cloud task, inject authorized credentials,
materialize resources inside the task boundary, stream tool results, persist
artifacts, and clean up.

## Adapter Boundary

Introduce or formalize an execution adapter behaviour with cloud-neutral input:

- workspace ID, agent ID, run/session ID.
- execution mode: planning read-only or coding workspace-write.
- resolved resource descriptors and grant IDs.
- multiple resources per run/session, including multiple Git repositories.
- requested ref, snapshot, or provider-specific locator.
- limits: CPU, memory, disk, timeout, output caps.
- artifact retention policy.
- network policy as explicit allowed hosts plus named policy sets such as
  `github`, `npm`, `pypi`, or `aws_services`.

The AWS adapter translates that input into:

- ECS/Fargate task launch and stop operations.
- task definition/container overrides.
- IAM role/session policy choices.
- Secrets Manager/SSM references or minted short-lived provider tokens.
- S3 artifact prefixes.
- CloudWatch log streams and metrics.
- optional EFS cache mounts.
- VPC/subnet/security-group/egress policy selection.

Runtime callers should not branch on AWS concepts. They should select an
execution target and pass a normalized resource execution request.

## Workspace Materialization

Runtime should materialize resources into deterministic paths inside the worker
workspace:

```text
/workspace/resources/parallel-agent-platform
/workspace/resources/parallel-agent-runtime
/workspace/resources/harper-server
```

Each materialized resource should record:

- resource ID and grant ID.
- alias/path.
- kind, provider, locator, ref/commit.
- required vs optional.
- credential reference used, without secret value.
- materialization status and structured error if unavailable.

Resource aliases must be sanitized before being used as filesystem path
components. The materializer should accept only simple identifier slugs, for
example lowercase letters, numbers, `_`, and `-`, and should reject or
canonicalize aliases containing `/`, `..`, shell metacharacters, or unicode
lookalikes. The final resolved path must still be checked against the workspace
root after joining.

Planning defaults should be read-only. Coding runs may later use
workspace-write mode, but write access should be explicit per resource.

## Warm Worker Sessions

Per-run containers are the first smokeable implementation because cleanup is
simple: when the task exits, task-local storage disappears. Interactive planning
should then move to short-lived per-session workers to avoid repeated ECS
startup and clone/fetch costs while the user is actively working.

Runtime owns warm-worker lifecycle:

- Start a worker for the planning session.
- Keep it alive while heartbeats or active tool calls continue.
- Reuse materialized repositories/resources across turns in that session.
- Stop it on idle timeout, explicit close, cancellation, max lifetime, grant
  change, or infrastructure pressure.
- Recreate the worker from resource descriptors/refs when a later turn resumes
  after cleanup.

Recommended initial dev defaults:

- Per-run worker for the hello-world, public clone, artifact, and private clone
  smoke tests.
- Session worker after those pass.
- Idle timeout: 15 minutes to start; tune after measuring task start latency and
  user interaction patterns.
- Max lifetime: 3 hours to start; tune after observing cost and stale-session
  behavior.
- Stop or refresh the session when a grant used by the worker is removed or
  downgraded.

## Runtime PR Plan

### RT-PR1: Execution adapter contract

Responsibilities:

- Define an execution adapter behaviour/module boundary.
- Add an AWS adapter implementation stub that can run a no-op/hello-world task
  when configured.
- Keep existing local helper routing intact.
- Return structured errors for missing adapter config, unsupported execution
  mode, missing resource grant metadata, and unavailable capacity.

Smoke tests:

- Unit test adapter selection for local helper vs. container/AWS.
- Config test: AWS target with missing cluster/task config is rejected before
  task launch.
- CLI or mix smoke that calls the stub path and receives a structured
  "not configured" or "hello-world started" response.

### RT-PR2: AWS task scheduler lifecycle

Infrastructure prerequisite: Platform Terraform has a hello-world ECS task,
execution role, security group, subnets, and CloudWatch log group.

Responsibilities:

- Launch ECS/Fargate tasks.
- Poll task state until terminal status.
- Surface task ARN, status, stopped reason, container exit code, and log stream.
- Stop tasks on cancellation/timeout.
- Reconcile orphaned tasks after Runtime restart.
- Persist launched task ARNs with run/session IDs, workspace IDs, timeout, and
  terminal state. Also tag ECS tasks with stable ownership fields such as
  `runtime=parallel-agent-runtime`, `workspace_id`, `session_id`, and `run_id`
  so Runtime can enumerate owned tasks after restart even if local process
  state is lost.

Smoke tests:

- Positive: launch hello-world task and observe exit code `0`.
- Negative: bad task definition or image tag returns a structured launch or
  image-pull failure.
- Negative: timeout path stops a long-running task.

### RT-PR3: Public repository direct clone

Infrastructure prerequisite: scheduler lifecycle works and the task has Git
egress.

Responsibilities:

- Build or configure an executor image with `git`.
- Pass repository URL/ref/resource metadata to the task.
- Clone a public repository into task-local workspace storage.
- Run read-only inspection commands inside the workspace.
- Reject tool cwd/path requests outside the workspace.

Smoke tests:

- Clone a public test repository at a specific commit.
- `git rev-parse HEAD` matches the requested commit.
- Bad URL and bad ref produce structured failures.
- Path traversal outside the workspace is denied.

### RT-PR4: Multi-repository planning workspace

Infrastructure prerequisite: public direct clone works.

Responsibilities:

- Accept multiple repository resources in one normalized execution request.
- Clone/materialize each repository into a deterministic alias path.
- Track materialization status per resource.
- Expose aliases/paths to tool context without leaking credentials.
- Support required vs optional resources.

Smoke tests:

- Clone two public repositories at explicit refs.
- Read/search tool calls work across both aliases.
- Path containment prevents escape from the workspace root.
- Missing required repo fails the run.
- Missing optional repo is surfaced as unavailable while the run can continue.

### RT-PR5: Artifact upload

Infrastructure prerequisite: S3 artifact bucket/prefix and scoped task role
exist.

Responsibilities:

- Upload summary JSON, command logs, and final patch/review artifacts to the
  configured artifact prefix.
- Return artifact references to Platform.
- Preserve failure artifacts when clone/tool execution fails.

Smoke tests:

- Positive: write to own run prefix.
- Negative: write to a different workspace/run prefix fails with access denied.
- Failed run still uploads or returns useful diagnostics.

### RT-PR6: Resource authorization enforcement

Infrastructure prerequisite: Harper resource/grant schema and Platform
resolution API are available.

Responsibilities:

- Require resource grant metadata for cloud materialization.
- Reject wrong workspace, wrong agent, disabled grant, wrong mode, and missing
  credential before task launch.
- Include resource ID/type/grant ID in audit events.
- Stop or refresh warm workers when one of their materialized resource grants is
  removed, disabled, or downgraded.
- Distinguish tool authorization from resource authorization: the tool grant
  permits the action, the resource grant permits the target.
- Define revocation propagation for warm workers. The first implementation
  should re-validate grant versions on heartbeat and before each tool call; a
  later implementation may add Platform push events for faster invalidation.
  Until push events exist, heartbeat/tool-call revalidation is the correctness
  boundary.

Smoke tests:

- Authorized planning agent launches against a granted repository.
- Authorized planning agent launches against multiple granted repositories.
- Unauthorized agent fails before ECS task creation.
- Read-only resource grant cannot request workspace-write execution.
- Existing warm worker does not continue serving a resource after its grant is
  removed.

### RT-PR7: Private repository credentials

Infrastructure prerequisite: credential storage path and IAM access exist.

Production gate: this PR must not be promoted to production before RT-PR6
authorization enforcement is live. Credential resolution without full grant
validation creates a security window. If RT-PR7 is merged earlier for
development, it must be behind a feature flag that refuses production private
credential injection until RT-PR6 enforcement is enabled.

Responsibilities:

- Resolve a credential reference from the resource grant context.
- Mint or fetch a short-lived repository token.
- Inject credentials into the executor without exposing them to model prompts,
  tool-call logs, CloudWatch, or artifacts.
- Support GitHub App installation tokens as the default GitHub path.
- Resolve credentials independently per resource in multi-repo sessions.

Smoke tests:

- Clone authorized private test repository.
- Clone mixed public/private repositories in one planning session.
- Unauthorized private repository clone fails before or during credential
  resolution.
- Secret value does not appear in logs/artifacts/events.

### RT-PR8: EFS mirror cache

Infrastructure prerequisite: Platform Terraform has EFS, access points, mount
targets, task mounts, and NFS security group rules.

Responsibilities:

- Move bare mirror cache to the configured mounted cache root.
- Keep per-run working trees on task-local storage.
- Record cache hit/miss, fetch timing, checkout timing, and rebuild events.
- Rebuild corrupt cache entries without deleting unrelated caches.
- Add concurrent-write protection for bare mirror updates. Multiple ECS tasks
  may fetch the same mirror simultaneously, so the implementation must choose a
  strategy such as an advisory lock file on EFS, atomic fetch-into-temp plus
  rename, or a serialized cache-warmer process. Do not rely on Git ref locks
  alone as the cross-task cache consistency mechanism.

Smoke tests:

- First run creates mirror cache.
- Second run hits mirror cache and records cache-hit metadata.
- Corrupt cache triggers rebuild.
- Task cannot mount or read an unrelated cache access point.
- Concurrent tasks fetching the same repository do not corrupt the mirror cache.

### RT-PR9: Cleanup and leases

Infrastructure prerequisite: lease metadata store and scheduled cleanup task or
Runtime reaper path are available.

Responsibilities:

- Write run/session/cache lease metadata.
- Reap stale sessions and orphaned tasks.
- Track warm worker heartbeat, idle deadline, max lifetime, and materialized
  resource grant versions.
- Cooperate with Platform cleanup alarms/metrics.

Smoke tests:

- Expired session workspace is deleted.
- Active leased workspace is preserved.
- Orphaned ECS task is stopped or marked for investigation.
- Cleanup failures emit structured metrics/logs.
- Active warm worker stays alive while heartbeats continue and stops after idle
  timeout.

## Acceptance Criteria

- A planning agent can inspect an authorized public repository in AWS using a
  Runtime AWS adapter.
- A planning agent can inspect multiple authorized repositories in one AWS
  worker/session.
- A planning agent can inspect an authorized private repository without exposing
  credentials.
- Credential secret values do not appear in CloudWatch logs, CloudTrail event
  fields controlled by Runtime, task lifecycle events, model prompts, tool-call
  logs, or artifact uploads.
- Unauthorized resources are rejected before task launch.
- Tool execution is contained to the materialized workspace.
- Runtime emits normalized events so Platform does not need AWS-specific UI
  branches.
- The direct-clone path works before EFS caching is introduced.
- Warm session reuse is available only after per-run lifecycle and cleanup are
  proven.
