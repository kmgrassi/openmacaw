# Production Container Tool Execution Scope (Runtime)

This document scopes the **Runtime-side** work for production/cloud
execution of coding tools. It is the runtime-repo companion to the broader
scoping document in the Platform repo:

- Platform doc: `docs/production-container-tool-execution-scope.md` in
  `parallel-agent-platform`. That doc owns the architecture, the AWS
  components, the resolved decisions (container lifetime, network policy,
  scheduling owner, diff handoff, uncommitted changes), the smoke test
  catalog, the staged rollout, and the four **Terraform PRs**.

This doc owns the four **Runtime PRs** that pair with the Platform
application PRs and the Terraform PRs. It intentionally does not
re-litigate decisions that already live in the Platform doc — when those
decisions change, the Platform doc is the source of truth.

## Summary of Runtime's role

Per the resolved decisions in the Platform doc:

- **Runtime owns scheduling.** Platform API does not call ECS/Fargate
  directly. Runtime is the boundary that already knows the execution
  target (local helper vs. container) and is the natural owner of the
  task lifecycle (launch, heartbeat, cancel, reap).
- **Runtime owns the in-container executor.** The process inside the
  container that runs `shell.exec` and `apply_patch` is a Runtime
  artifact (binary + image), invoked over the Runtime↔executor bridge.
- **Runtime owns the artifact upload.** The patch and non-error logs are
  uploaded to S3 from inside the run; Platform receives a `run.finished`
  event with artifact references, then handles DB persistence and any
  GitHub branch push.

## Required Runtime PRs

Each Runtime PR pairs with one Platform application PR and one Terraform
PR. The pairings are:

| Runtime PR | Platform application PR | Terraform PR |
|---|---|---|
| RT-PR1: Execution-target consumer | App PR1 (Container Execution Contract) | none |
| RT-PR2: ECS scheduler and task lifecycle | App PR2 (Workspace Bootstrap and Isolation) | TF-PR1 + TF-PR2 |
| RT-PR3: In-container executor and bridge | App PR3 (Container Tool Executor) | TF-PR1 + TF-PR3 |
| RT-PR4: Artifact upload and run-finished signal | App PR4 (Artifact, Diff, and Review Handoff) | TF-PR4 |

### Runtime PR 1: Execution-target consumer

Branch suggestion: `codex/container-runtime-execution-target`

Infrastructure prerequisite: none.

Pairs with: App PR1 (Container Execution Contract).

Responsibilities:

- Consume the new `container` execution-target type defined by App PR1.
- Add a routing path in Runtime that selects between `local_helper` and
  `container` execution targets based on the resolved execution profile.
- Normalize tool-result events from both targets to the same shape, so
  downstream consumers cannot tell which target produced an event.
- Reject runs at submission time when no valid execution target is
  available (e.g. workspace allows only `container` but no container
  capacity is configured).

Acceptance criteria:

- Runtime can dispatch a coding run to either `local_helper` or
  `container` based on profile; the model tool schema is identical for
  both.
- Tool-result events emitted by Runtime carry a normalized envelope that
  downstream Platform code consumes without branching on target type.
- Submission-time rejection is observable as a structured error, not a
  runtime crash.

### Runtime PR 2: ECS scheduler and task lifecycle

Branch suggestion: `codex/container-runtime-scheduler`

Infrastructure prerequisite: **TF-PR1 (Foundation)** and **TF-PR2
(Execution Stack)** must be merged and applied to the target environment.

Pairs with: App PR2 (Workspace Bootstrap and Isolation).

Responsibilities:

- Implement the scheduler that launches ECS/Fargate tasks (directly via
  `RunTask` or through the Step Functions state machine provisioned in
  TF-PR2).
- Inject per-run environment: workspace ID, run ID, repository ref,
  artifact prefix, scoped STS credentials, allowlisted secret references.
- Maintain task lifecycle: track `RUNNING`/`STOPPED` transitions, enforce
  per-run timeout, handle cancellation via `StopTask` (honoring the
  `stopTimeout` for graceful shutdown), and reap orphaned tasks if the
  scheduler crashes mid-run.
- For interactive sessions, enforce idle timeout and heartbeat per the
  Platform doc's [container-lifetime decision].
- Surface scheduler-side failures (RunTask throttled, image pull failed,
  capacity unavailable) as structured errors that Platform can render.

Acceptance criteria:

- Runtime can launch a task into the cluster end-to-end, observe it run
  to completion, and clean up.
- A cancelled run results in `SIGTERM` reaching the executor before the
  `stopTimeout` deadline; a `SIGKILL` happens only when the executor
  fails to exit cleanly.
- An orchestrator restart mid-run does not leak ECS tasks: a reaper job
  reconciles task state against Runtime's view within a bounded window.
- All four scheduling smoke tests defined in the Platform doc (Task
  launch, Cancellation, Egress allow, Egress deny) pass against this
  Runtime version.

### Runtime PR 3: In-container executor and bridge

Branch suggestion: `codex/container-runtime-executor`

Infrastructure prerequisite: **TF-PR1 (Foundation)** and **TF-PR3
(Logging)** must be merged and applied. TF-PR1 provides the ECR
repository and the GitHub Actions OIDC role this PR's CI pipeline uses
to push the executor image; TF-PR3 provides the Firelens log routing
the executor streams events through.

Pairs with: App PR3 (Container Tool Executor).

Responsibilities:

- Build the in-container executor binary that implements `shell.exec` and
  `apply_patch` with the same policy semantics as the local helper:
  argv-only input, cwd containment, timeout, output caps, cancellation,
  env allowlist, structured patch validation, path safety.
- Provide the Runtime↔executor bridge (transport + framing) that lets
  Runtime send tool calls to the executor and receive streamed events
  back. Reuse local-helper bridge code where possible.
- Package the executor into the OCI image that TF-PR1 stores in ECR. CI
  builds and pushes the image on merge to main (workflow lives here;
  IAM/OIDC role lives in TF-PR1 alongside the ECR repository).
- Stream stdout/stderr through the Firelens severity split (non-error →
  S3, error → CloudWatch) per the Platform doc's logging strategy.
- Emit normalized events that match the local-helper shape so RT-PR1's
  normalization layer is a no-op for container output.

Acceptance criteria:

- The executor image runs a real coding workload end-to-end inside the
  cluster: `shell.exec` reads/searches/lists, runs git, runs tests;
  `apply_patch` edits files inside the mounted workspace.
- Path-traversal and unsafe-patch attempts are rejected with the same
  errors the local helper produces.
- The Runtime↔executor bridge handles disconnects and partial events
  without dropping in-flight tool calls.
- The Log split smoke tests (non-error and error) pass.

### Runtime PR 4: Artifact upload and run-finished signal

Branch suggestion: `codex/container-runtime-artifact-handoff`

Infrastructure prerequisite: **TF-PR4 (Artifacts and Observability)**
must be merged and applied so the artifact bucket, KMS key, and
EventBridge schedule exist.

Pairs with: App PR4 (Artifact, Diff, and Review Handoff).

Responsibilities:

- Capture the final patch and command summary at the end of a run and
  upload them to the run's S3 prefix using the scoped STS credential.
  The patch artifact is the source of truth for the run's output per
  the Platform doc's diff-handoff decision.
- Emit a `run.finished` event over EventBridge (or the existing Runtime
  → Platform channel, whichever is decided in App PR4) with the
  artifact references, exit status, and structured failure diagnostics.
- Ensure the `End-to-end` smoke test from the Platform doc's catalog
  passes against this Runtime version.
- Wire alarm-friendly metrics (task start latency, run duration, exit
  code distribution, artifact upload success/failure) so the rollout
  dashboard provisioned in TF-PR4 is populated.

Acceptance criteria:

- A successful run writes its patch to its own S3 prefix and cannot
  write to another run's prefix (verified by the STS-scope-negative
  smoke test).
- A failed run still emits a `run.finished` event with enough
  diagnostics for Platform to render the failure without re-running.
- The end-to-end smoke test passes consistently.

## Cross-references

- **Platform doc** (architecture, decisions, smoke catalog, staged
  rollout, Terraform PRs): `docs/production-container-tool-execution-scope.md`
  in `parallel-agent-platform`.
- **Local-helper coding runner scope**: prior art for the `shell.exec` /
  `apply_patch` schemas, policy semantics, and bridge framing that
  RT-PR1 and RT-PR3 reuse. See the platform repo's
  `docs/local-model-coding-runner-scope.md`.

## What this doc deliberately does not own

- AWS resource definitions (Terraform). Those live in the platform repo
  alongside `apps/api/infra/`, scoped as TF-PR1 through TF-PR4.
- The model-facing contract for coding tools. That lives in the
  platform repo's `contracts/` directory and is owned by App PR1.
- Platform-side persistence, GitHub branch pushes, and UI handoff. Those
  are owned by App PR4.
