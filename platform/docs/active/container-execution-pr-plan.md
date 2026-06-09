# Container Execution — PR Plan (finish-it)

Operationalizes [`production-container-tool-execution-scope.md`](./production-container-tool-execution-scope.md)
into independently-assignable PRs **from the current state of the code**, so
the remaining work can be parallelized across agents.

The design (container lifetime, network policy, staged rollout, smoke catalog)
is settled in the scope doc — read it for the *why*. This plan is the *what's
left and in what order*, with the seams each PR plugs into.

**Goal:** coding tasks (`shell.exec` / `apply_patch`) run in a per-run (async)
or per-session (interactive) **isolated cloud container**, dispatched by the
orchestrator, instead of as a subprocess inside the orchestrator container.

---

## Current state — built vs. remaining

**Already built (do not rebuild):**

| Piece | Where | State |
|---|---|---|
| Platform execution-target contract | `platform/contracts/execution-profile.ts` (`ContainerExecutionDispatchMetadataSchema`, `NetworkPolicySchema`, `ContainerDispatchLimitsSchema`, `ArtifactRetentionSchema`); parsed in `apps/api/src/services/runtime-dispatch-context.ts`; `services/local-coding-execution-target.ts` | ✅ in code |
| Worker-bridge launch seam | `runtime/apps/orchestrator/lib/symphony_elixir/worker_bridge/server.ex` — **injectable `port_opener`** (`init/1` ~L93), session lifecycle (`heartbeat_session`, `reap_stale_sessions`, `stop_session`), `build_launch_spec` (~L308), `@supported_kinds ~w(codex)` (L44) | ✅ local-process backend only |
| AWS RunTask scheduler | `runtime/.../cloud_execution/aws/` — `task_scheduler.ex` (`run_task` ~L27), `ecs_client.ex` (mockable via `Application.get_env(:symphony_elixir, :aws_ecs_client, EcsClient)`), `task_store.ex`, `config.ex`, `task_record.ex` | ✅ built, **not wired into dispatch** |
| Terraform — foundation | `infra/terraform/stacks/container-execution-foundation/` — ECR, KMS, VPC endpoints, CloudWatch log group/dashboard/alarm, artifacts | ✅ written, **not applied / not in deploy pipeline** |
| Terraform — runtime | `infra/terraform/stacks/container-runtime/` — ECS task def, 2 IAM roles + policies, security group + egress | ✅ written, **not applied** |

**Remaining (this plan):**

1. The **in-container executor + image** — the process that runs the tools inside the container (does not exist).
2. **Worker-bridge container backend** — wire the scheduler behind the `port_opener` seam (not wired).
3. **Route coding runs through the worker bridge** — today `runner/codex.ex:36` and `runner/claude_code.ex:24` launch direct subprocesses, bypassing the bridge.
4. **DB-column promotion** of `execution_target_kind` ([`execution-target-schema-pr-plan.md`](./execution-target-schema-pr-plan.md)).
5. **Apply the Terraform** (foundation → runtime) to dev, **build+push the executor image**.
6. **Security infra** — Network Firewall, Step Functions lifecycle, Secrets Manager scoping, S3 artifact bucket + per-run STS.
7. **Artifact / diff / review handoff.**
8. **Smoke catalog + staged rollout.**

---

## Parallelization map

Each PR lists its dependencies. PRs in the same **wave** have no dependency on
each other and can be assigned to different agents simultaneously.

```
Wave 1 (start immediately, fully parallel)
  ├─ A1  In-container executor + image        (runtime; local Docker; no infra)
  ├─ B1  Worker-bridge container backend       (runtime; mock ECS; config-gated)
  ├─ C1  execution_target_kind DB column        (platform + migration)
  └─ D1  Apply foundation TF to dev + image CI  (infra; human-approved)

Wave 2 (each needs its Wave-1 parent)
  ├─ B2  Route coding runs through worker bridge   (needs B1)
  └─ D2  Apply runtime TF to dev                    (needs D1)

Wave 3 (first real dev end-to-end + hardening)
  ├─ D3  Security infra: NetFW + StepFns + Secrets + S3/STS  (needs D2)
  ├─ E1  Artifact / diff / review handoff            (needs A1 + D3's S3)
  └─ INT First dev end-to-end run                    (needs A1+B1+B2+D1+D2)

Wave 4 (rollout)
  ├─ F1  Smoke catalog + schedule + alarms           (needs D3)
  └─ F2  Routing flag + staged rollout               (needs INT green)
```

**Critical path:** A1 → B1/B2 → D1 → D2 → D3 → INT → F. C1 is off the critical
path. D-series is human-approval-gated (infra) and the long pole.

---

## PRs

### A1 — In-container coding executor + image
*Repo:* runtime (+ a new image build). *Deps:* none. *Parallel with:* B1, C1, D1.
*Risk:* low (locally testable, no prod surface). *Maps to:* scope App PR 3 + the executor image for foundation ECR.

**Build the process that runs *inside* the container.** It receives
`shell.exec` and `apply_patch` and executes them in the checked-out workspace.

Responsibilities:
- **Reuse the existing tool-execution logic**, do not re-invent it. The local
  helper already runs these tools with the right semantics (cwd containment,
  timeout, output caps, env allowlist, path-safe patch). Factor that into a
  shared executor core the container image can run. Match the event/result
  shapes the runtime already consumes (see `local-coding-execution-target.ts`
  and the local-helper tool contract).
- Define the **executor ↔ runtime transport** (the channel the worker-bridge
  container backend in B1 will speak): a small framed protocol over the task's
  stdio or a socket — `tool_call_request` in, `tool_call_result` / progress /
  `complete` out. Normalize to the same shapes as the local-helper path so the
  Platform UI renders identically.
- **Dockerfile** for the executor image: minimal base, `git`, the executor
  binary/script, an entrypoint that (a) checks out `repository@ref` into the
  workspace (committed refs only — v1 scope), (b) starts the executor loop.
- **Local smoke test** (`make`/`pnpm run smoke:container-local` or `mix`):
  `docker build` the image, run one `shell.exec` + one `apply_patch` against a
  throwaway repo, assert the patch lands and events stream. **No AWS.**

Acceptance:
- `shell.exec` can read/search/list, inspect git, run tests/builds in the workspace.
- `apply_patch` edits files in the mounted workspace and rejects unsafe paths.
- Events emitted match the local-helper normalized shape.
- The whole thing runs and passes in a local Docker container with no cloud deps.

---

### B1 — Worker-bridge container backend (wire the scheduler)
*Repo:* runtime. *Deps:* none (uses the mock ECS client). *Parallel with:* A1, C1, D1.
*Risk:* low (config-gated, off by default; mockable). *Maps to:* scope's "Scheduling owner = Runtime".

Wire `cloud_execution/aws/TaskScheduler` behind the worker bridge's existing
injectable `port_opener` seam.

Responsibilities:
- Add a **container backend** selectable by the worker bridge: when the launch
  spec's execution target is `container`, instead of `open_port/1`
  (`Port.open` local process), call `TaskScheduler.launch(...)` to `RunTask`
  the executor image, and adapt the returned task handle so the bridge's
  existing session entry / lifecycle (`heartbeat_session`, `reap_stale_sessions`
  → `StopTask`, exit handling) works against an ECS task instead of a port.
- Translate `ContainerExecutionDispatchMetadata` (repo source, ref, limits,
  network policy, artifact retention) into the `run_task_payload`
  (`task_scheduler.ex:168`) — overrides, env, resource limits.
- **Config gate** (`Config.settings!()`): default off → bridge keeps using the
  local backend; on → container backend. Inert until D1/D2 provision real infra.
- Unit tests with `Application.put_env(:symphony_elixir, :aws_ecs_client, MockEcsClient)` — assert RunTask payload shape, lifecycle, and reap→StopTask.

Acceptance:
- With the mock client, a `kind=codex`, `executionTarget=container` session
  issues a correctly-shaped `RunTask` and the bridge tracks/reaps it.
- With the gate off, behavior is byte-for-byte the current local path.

---

### B2 — Route coding runs through the worker bridge
*Repo:* runtime. *Deps:* B1. *Risk:* medium (changes the live codex/claude path).

Today the normal run path bypasses the bridge: `runner/codex.ex:36`
(`AppServer.start_session`) and `runner/claude_code.ex:24`
(`Bridge.start_session`) spawn direct subprocesses. The OAuth codex path already
goes through the worker bridge (see
[`codex-oauth-coding-agent.md`](../reference/codex-oauth-coding-agent.md)).

Responsibilities:
- Make the coding-run dispatch consult the resolved **execution target** and,
  for `kind=container`, launch via the worker bridge's container backend (B1)
  instead of the direct `AppServer`/`Bridge` subprocess. Keep `local_helper`
  and in-orchestrator subprocess paths intact for non-container agents.
- Unify so the bridge is the single launch surface for codex/claude_code
  (the direct path becomes the `local`/in-orchestrator backend behind the same
  seam) — avoid a third parallel path.
- Extend `@supported_kinds` if `claude_code` should also run containerized.

Acceptance:
- An agent with `executionTarget.kind=container` runs its coding turn in a
  container (mock/dev); an agent without it is unchanged.
- One launch surface; no duplicated dispatch logic.

---

### C1 — Promote `execution_target_kind` to a DB column
*Repo:* platform (+ migration). *Deps:* none. *Parallel with:* A1, B1, D1.
*Risk:* low. *Maps to:* [`execution-target-schema-pr-plan.md`](./execution-target-schema-pr-plan.md) (follow that plan).

Promote `agent.tool_policy.executionTarget.kind` (JSONB) to a real column with
`CHECK (execution_target_kind IN ('local_helper','container'))`, backfill,
drop the JSONB key, switch the service layer — all in one PR (no transitional
column, per the No-Backwards-Compat rule).

**Confirm the migration home first:** `agent` may live in `harper-server` or in
OpenMacaw-owned `platform/supabase/migrations/`. Confirm before drafting.

Acceptance: per the linked plan — DB rejects invalid kinds; API runtime check
becomes defense-in-depth; existing rows default to `local_helper`.

---

### D1 — Apply foundation TF to dev + executor-image CI
*Repo:* infra (+ a build workflow). *Deps:* none. *Parallel with:* A1, B1, C1.
*Risk:* infra — **human-approved apply**. *Maps to:* scope Terraform PR 1.

Responsibilities:
- Apply `infra/terraform/stacks/container-execution-foundation/` to **dev**
  (ECR, KMS, VPC endpoints, observability). Review the plan; apply per the
  infra approval policy.
- Add the GitHub Actions workflow that builds A1's executor image and pushes to
  the foundation ECR on merge to main (OIDC role from the stack). **Stage 0
  (bake) only — no runtime traffic.**

Acceptance: `terraform plan` clean; ECR accepts a push from the OIDC role; a
placeholder/real image is resolvable by a sample `RunTask`.

---

### D2 — Apply runtime TF to dev
*Repo:* infra. *Deps:* D1. *Risk:* infra — human-approved. *Maps to:* scope Terraform PR 2 (base).

Apply `infra/terraform/stacks/container-runtime/` to dev (ECS task def, IAM
execution + per-run roles, security group, egress). Confirm Runtime can
manually `RunTask` the cluster and observe run-to-completion.

Acceptance: a task launches into the dev cluster and runs to `STOPPED (exit 0)`.

---

### D3 — Security infra: Network Firewall, Step Functions, Secrets, S3/STS
*Repo:* infra. *Deps:* D2. *Risk:* **high — security-critical**. *Maps to:* scope Terraform PR 2 (remainder) + PR 4.

The isolation guarantees. Each sub-piece is independently reviewable but should
land together as the security boundary:
- **Network Firewall** — deny-all egress + FQDN allowlist (registries, GitHub,
  Platform/Runtime endpoints); VPC endpoints keep AWS traffic off NAT.
- **Step Functions** (or equivalent) — owns RunTask → wait → handle-failure →
  cleanup; the runtime calls it instead of raw RunTask for lifecycle safety.
- **Secrets Manager** paths + KMS — per-workspace/run secret scoping; opt-in;
  never logged.
- **S3 artifact bucket** + **per-run STS session policy** scoping writes to the
  run's prefix only.

Acceptance: egress-allow vs egress-deny behave; cross-workspace secret/S3 reads
get `AccessDenied`; cancellation delivers SIGTERM within `stopTimeout`.

---

### E1 — Artifact, diff, and review handoff
*Repo:* runtime + platform. *Deps:* A1, D3 (S3). *Risk:* medium. *Maps to:* scope App PR 4.

Persist the final patch/diff/logs to the run's S3 prefix (source of truth);
optional branch/PR push as a UX affordance; retention policy; failure
diagnostics surfaced in Platform.

Acceptance: a successful run produces a reviewable patch artifact + (optional)
branch; Platform shows commands run / files changed / artifact location.

---

### INT — First dev end-to-end
*Deps:* A1 + B1 + B2 + D1 + D2. Not a code PR — an integration checkpoint.

Run one real coding task in a dev container end-to-end: orchestrator dispatch →
worker-bridge container backend → RunTask executor image → `shell.exec` +
`apply_patch` → events to Platform → teardown. This is the **Stage 1 → Stage 2
gate** from the scope's staged rollout.

---

### F1 — Smoke catalog + schedule + alarms
*Repo:* infra + runtime. *Deps:* D3. *Maps to:* scope "Infrastructure Smoke Tests" + Terraform PR 3/4 observability.

Implement the 11-test smoke catalog (task launch, log split, egress allow/deny,
secrets injection, STS scope ±, VPC endpoint reachability, queue round-trip,
cancellation, end-to-end), the `pnpm run smoke:container` harness, the
EventBridge schedule, and one CloudWatch alarm per test.

Acceptance: each test emits a single pass/fail metric; forcing one to fail
trips its alarm.

---

### F2 — Routing flag + staged rollout
*Repo:* platform. *Deps:* INT green + F1. *Maps to:* scope Stages 2–4.

Per-workspace routing flag with a configurable percentage; allowlist → 5% →
25% → 50% → default, each with its go/no-go signal; one-config rollback to
local-helper-default.

---

## Cross-cutting notes

- **One launch surface.** The end state is: worker bridge is the single place
  coding runs launch, with pluggable backends — `local` (in-orchestrator
  subprocess, today's `AppServer`/`Bridge`), `local_helper` (laptop relay),
  `container` (Fargate via scheduler). B2 must collapse the direct path, not
  add a fourth.
- **Config-gate everything app-side** so A1/B1/B2 can merge and sit inert until
  the infra (D-series) is applied. Nothing changes production behavior until
  the routing flag (F2) turns it on for a workspace.
- **Committed refs only (v1).** Container runs check out a branch/tag/SHA;
  snapshotting uncommitted local changes is explicitly out of scope.
- **Infra is human-approval-gated.** Every `apply` under `infra/` needs explicit
  human review (project policy). D1–D3 are the long pole; start D1 early.
- **Reuse, don't fork.** A1's executor and the local-helper executor should
  share one core so `shell.exec`/`apply_patch` semantics can't drift between
  placements.

## References
- Design + decisions + staged rollout: [`production-container-tool-execution-scope.md`](./production-container-tool-execution-scope.md)
- DB column: [`execution-target-schema-pr-plan.md`](./execution-target-schema-pr-plan.md)
- Codex OAuth (worker-bridge credential path): [`../reference/codex-oauth-coding-agent.md`](../reference/codex-oauth-coding-agent.md)
