# Agent Health Diagnostic — Runtime PR Plan

Sequenced PR plan for the **Agent Health Diagnostic** work that surfaces
runtime-side reasons an agent is unrunnable *before* a user pings it and
hits a runtime crash.

What triggered this work: a user pinging the Coding Agent in production
hit `:erlang.port_command/2 :badarg` because the `codex` CLI is missing
from the orchestrator container. The crash path is
`Codex.AppServer.start_port` (`apps/orchestrator/lib/symphony_elixir/codex/app_server.ex:198-221`),
which spawns `bash -lc "<codex_command>"`. The container has `bash`, so
the port opens — but `codex` itself is not on `PATH` in any recent
`symphony-orchestrator-prod` task def revision (audited against
`apps/orchestrator/deploy/Dockerfile` — the install list is
`awscli ca-certificates curl git gnupg` plus `gh`, no `codex`). The
port then exits with status 127, the next `Port.command/2` runs against
a dead port, and the runner crashes. The user sees nothing useful.

Two tiers, layered so failures get caught as early as possible:

- **Tier 1 — Startup container inventory.** Orchestrator emits a
  structured `container_inventory_completed` event on boot listing
  required binaries and env vars (present/missing). CloudWatch alarms
  on the missing-binary warnings catch this class of bug at deploy
  time, before any user hits it.
- **Tier 2 — Per-agent dry-run probe.** Runtime HTTP endpoint that, for
  a given agent, runs the same code path as a real chat session up to
  but not including the LLM call, and returns a structured outcome.
  Platform calls this on workspace-open / login and surfaces broken
  agents in the UI before the user clicks "send."

This repo owns both tiers' implementation. The platform owns Tier 2's
user-facing surface (proxy endpoint + UI) and has its own companion
scope at
[`parallel-agent-platform/docs/active/agent-health-diagnostic-pr-plan.md`](../../../parallel-agent-platform/docs/active/agent-health-diagnostic-pr-plan.md).

## Status legend

| Marker | Meaning |
|---|---|
| 🟢 | Ready to start — no blocking prerequisites in this repo. |
| 🟡 | Blocked on a prior PR in this plan. |
| ✅ | Merged. |

## Sequencing

```
RT-DIAG-1 (inventory) ─┐
RT-DIAG-2 (codex CLI) ─┼─► (Tier 1 done)
RT-DIAG-3 (sched err) ─┘

RT-DIAG-1 ─► RT-DIAG-4 (probe) ─► RT-DIAG-5 (per-agent endpoint) ─► RT-DIAG-6 (batch endpoint)
```

RT-DIAG-1, 2, 3 are all independent of each other and of the Tier 2
chain except where noted below. RT-DIAG-4 depends on 1 only because the
probe's failure-shape reuses the inventory module to self-describe
missing-binary failures.

## Tier 1 — Startup container inventory + hygiene

### 🟢 RT-DIAG-1: `container_inventory` startup log event

**Branch:** `feat/rt-diag-container-inventory`

**What.** New module `SymphonyElixir.Diagnostic.ContainerInventory`
at `apps/orchestrator/lib/symphony_elixir/diagnostic/container_inventory.ex`.
Invoked once during application boot, wired through
`apps/orchestrator/lib/symphony_elixir.ex`'s `Application.start/2`
(after the supervision tree is up but before the launcher accepts
traffic — so missing-binary warnings land in CloudWatch before any
user-driven path tries to use them).

Inspects:

| Check | Source | Required list (initial) |
|---|---|---|
| Binaries on `PATH` | `System.find_executable/1` | `bash`, `git`, `gh`, `aws`, `codex`, `ssh` |
| Env vars (presence only — never values) | `System.get_env/1` | `GH_TOKEN`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Task def revision (optional) | `ECS_CONTAINER_METADATA_URI_V4` HTTP GET | populated only when running on ECS |

The binary and env-var lists live in module attributes so future
additions are one-line changes.

**Log events.**

| Level | Event | Fields |
|---|---|---|
| `:info` | `:container_inventory_completed` | `binaries: %{"bash" => true, "codex" => false, ...}`, `env_vars: %{...}`, `task_def_revision: "..."` (or `nil`), `missing_binaries: ["codex", ...]`, `missing_env_vars: [...]` |
| `:warning` | `:container_inventory_binary_missing` | `binary: "codex"`, `expected_on_path: true` — one event per missing required binary, independently grep-able |
| `:warning` | `:container_inventory_env_missing` | `env_var: "OPENAI_API_KEY"` — same shape, one per missing required env var |

All events emitted via the existing `RuntimeLog.log/3` (already used
throughout the runner code path; see `agent_runner.ex:40`).

**Prerequisites.** None.

**Independent.** Yes.

**Validation.**
- Unit test: `ContainerInventory.run/0` returns the expected map shape
  with `binaries`, `env_vars`, `missing_binaries`, `missing_env_vars`
  keys.
- Unit test: when the required list contains a binary that
  `System.find_executable/1` cannot resolve (use a deliberately absent
  fake name like `__definitely_not_a_real_binary__`), the warning event
  for that binary is emitted exactly once.
- Unit test: env-var values are NOT included in any emitted event (only
  presence booleans). Regression guard against accidentally logging
  secrets.
- Smoke: after deploy, tail orchestrator logs and grep for
  `container_inventory_completed` — should appear within 30s of task
  start.

**Unblocks.** Would have caught the codex-missing crash at deploy
time. Also unblocks RT-DIAG-4 (the probe reuses this module to attach
self-describing context to `runner_spawn_failed` outcomes).

### 🟢 RT-DIAG-2: install `codex` CLI in the Dockerfile

**Branch:** `fix/rt-diag-install-codex-cli`

**What.** Add the `codex` CLI to `apps/orchestrator/deploy/Dockerfile`
so the local `Codex.AppServer.start_port` path actually finds the
binary it tries to spawn. Currently the apt install list is
`awscli ca-certificates curl git gnupg` plus `gh` — no `codex`.

**Where.** `apps/orchestrator/deploy/Dockerfile` only. Single-file change.

**Install via npm — channel confirmed.** OpenAI's official Codex CLI ships
as the npm package `@openai/codex` (confirmed via the npm registry; the
package's own description literally reads `npm i -g @openai/codex`). At
the time this scope was written the latest version was `0.133.0`, with
the binary entry point at `bin/codex.js` and Node `>=16` required. The
package bundles platform-specific helper binaries (including the `bwrap`
sandbox), so installing the single npm package gets everything the
runtime needs.

Dockerfile addition (sketch — confirm Node version policy and pin
exact `@openai/codex` version when writing the PR):

```dockerfile
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs && \
    npm install -g @openai/codex@<pinned-version> && \
    rm -rf /var/lib/apt/lists/*
```

Why npm and not the Rust release binaries directly:
- The npm package is what the OpenAI docs point at first.
- Bundles everything (codex + sandboxing helpers).
- Avoids per-arch URL + checksum pinning logic in the Dockerfile.
- Node is a small one-time add; we don't have other Node code in the
  container, but the cost (~70 MB image growth) is acceptable.

PR description should include: (a) the exact version pinned, (b) image
size delta before/after, (c) a CloudWatch verification step
post-deploy (look for `container_inventory_binary_missing` with
`binary: "codex"` to be absent after RT-DIAG-1 also lands).

**Prerequisites.** None.

**Independent.** Yes — can land in parallel with RT-DIAG-1. Once
RT-DIAG-1 is also merged, the inventory log line will flip
`"codex" => true` in the `container_inventory_completed` event.

**Validation.**
- Local: `docker build` succeeds; `docker run --entrypoint /bin/sh
  <new image> -c "which codex && codex --version"` prints a real
  version string.
- Post-deploy: grep CloudWatch for
  `container_inventory_binary_missing` with `binary: "codex"` — should
  be absent on the new task def revision.
- End-to-end: trigger a real Coding Agent ping in a workspace; the
  bash port now stays up past `start_port`.

**Note.** This is the fire-fighting PR for the immediate production
crash. The Manager Agent's PR-shepherding smoke
(`apps/orchestrator/docs/manager-agent-smoke-runbook.md`) also benefits
— coding-agent dispatches stop no-oping at the spawn step.

### 🟢 RT-DIAG-3: structured `manager_scheduler_exception` error reporting

**Branch:** `fix/rt-diag-manager-scheduler-error-fields`

**What.** Investigation-plus-small-fix PR. The manager scheduler in
production is ticking but most ticks idle with `manager_session_error`,
and at 14:18 UTC on the day this scope was written it emitted
`manager_scheduler_exception` with a 3.3s duration and no structured
cause fields. The current error path doesn't include enough to debug
without re-deriving from a stacktrace.

Add structured fields to the `manager_scheduler_exception` event:

| Field | Source |
|---|---|
| `error_class` | `Exception.format/2`-style module name (e.g. `RuntimeError`, `DBConnection.ConnectionError`) |
| `error_message` | The exception message (truncated to ~1KB) |
| `agent_id` | Manager agent id for the workspace, if resolvable |
| `workspace_id` | Already plumbed but confirm present |
| `tick_phase` | Which step of the tick we were in (`due_query`, `run_turn`, `tool_execute`, etc.) |

Also: spend ~30 minutes in the same PR investigating the actual
underlying error producing the 14:18 exception. Record findings in the
PR description. Two outcomes are acceptable:

1. The cause is small and obvious → fix it in this PR.
2. The cause is structural → file a follow-up issue and link from the
   PR description. The structured-fields work still ships.

**Prerequisites.** None.

**Independent.** Yes.

**Validation.**
- Unit test: helper that builds the field map from an arbitrary
  exception produces the expected shape and truncates oversize
  messages.
- Manual: in a dev environment, force an exception in the tick path
  (e.g. via a feature-flagged `raise`) and confirm the new fields land
  in the log.

## Tier 2 — Per-agent dry-run probe

### 🟡 RT-DIAG-4: `AgentProbe` module

**Branch:** `feat/rt-diag-agent-probe-module`

**What.** New module `SymphonyElixir.Diagnostic.AgentProbe` at
`apps/orchestrator/lib/symphony_elixir/diagnostic/agent_probe.ex`.

Public API:

```elixir
@spec probe(workspace_id :: String.t(), agent_id :: String.t()) ::
        {:ok, :ready}
        | {:error, reason :: atom(), details :: map()}
def probe(workspace_id, agent_id)
```

Steps, executed in order, returning `{:error, reason, details}` on the
first failure:

| Step | Reuses | Failure atom |
|---|---|---|
| 1. Resolve agent's gateway_config from Supabase | existing `launcher.gateway_config.fetch` path | `:gateway_config_missing` |
| 2. Resolve `runner_kind` + execution profile | `SymphonyElixir.ExecutionProfile` | `:execution_profile_unresolved` |
| 3. Resolve credential | existing `Credentials.resolve/...` | `:credential_missing` |
| 4. Call runner's `start_session/2` with a `probe_only: true` flag | runner behavior | `:runner_spawn_failed` |
| 5. Immediately call runner's `stop_session/1` | runner behavior | `:cleanup_failed` (informational only — probe still returns :ready if step 4 succeeded) |

The `probe_only: true` flag is added to the session config so runners
can short-circuit before doing any LLM work. **Runners must NOT call
`run_turn`** during a probe. Each runner needs a one-line update to
honor the flag (Codex: open the port, confirm it's alive,
immediately close; LocalRelay: open the socket, confirm registration,
close; etc.).

The `details` map for `:runner_spawn_failed` self-describes by
attaching the relevant slice of the inventory:

```elixir
{:error, :runner_spawn_failed,
 %{stage: "bash_port_dead",
   exit_status: 127,
   binary: "codex",
   container_inventory: %{"codex" => false, "bash" => true}}}
```

This is why RT-DIAG-1 is a prerequisite — the probe reuses
`ContainerInventory.snapshot/0` to fill that field.

**Prerequisites.** RT-DIAG-1.

**Independent.** No.

**Validation.**
- Unit tests covering each `:error` branch with a fixture that forces
  the corresponding failure (mock `Credentials.resolve` to return
  `:not_found`, etc.).
- Integration test: a known-broken agent gateway_config (missing
  credential) returns `{:error, :credential_missing, %{...}}`.
- Integration test: a known-good agent returns `{:ok, :ready}` end-to-end
  against a mock runner that honors `probe_only: true`.

### 🟡 RT-DIAG-5: HTTP endpoint `GET /api/v1/diagnostic/agent/:agent_id`

**Branch:** `feat/rt-diag-agent-probe-endpoint`

**What.** New route on the **launcher router** at
`apps/orchestrator/lib/symphony_elixir/launcher/router.ex` (port 4100).
The launcher router is where the existing `/health`, `/orchestrators`,
`/orchestrators/:id`, `/agents`, etc. live — natural home for a new
`/diagnostic/...` route. Do NOT add this to
`symphony_elixir_web/router.ex` (that's the Phoenix browser layer with
CSRF / session plugs, wrong shape for an internal JSON API).

Route: `GET /diagnostic/agent/:agent_id?workspace_id=<uuid>`.

Calls `AgentProbe.probe(workspace_id, agent_id)` and renders the
structured outcome as JSON via the existing `json_resp/3` helper.

**Auth: no auth plug — match the launcher router pattern.** Confirmed
via inspection of `launcher/router.ex`: existing routes (`/health`,
`/orchestrators`, `/agents`) have **no auth plug**. The security
boundary is network isolation — the launcher port is only reachable
from inside the ECS VPC, and the platform API server (which is the
only caller) sits in the same VPC. The new diagnostic endpoint
follows the same model.

If we later decide to add belt-and-suspenders auth to internal
endpoints, that's a project-wide change spanning every route on this
router — not a per-route concern, and not in scope for this PR.

**JSON contract** (must be documented verbatim in the PR description
so PLAT-DIAG-1 can consume it without follow-up):

```json
// 200 OK — ready
{
  "agent_id": "uuid",
  "workspace_id": "uuid",
  "status": "ready"
}

// 200 OK — not ready (intentional 200 so the platform parses the body)
{
  "agent_id": "uuid",
  "workspace_id": "uuid",
  "status": "not_ready",
  "reason": "runner_spawn_failed",
  "details": {
    "stage": "bash_port_dead",
    "binary": "codex",
    "container_inventory": { "codex": false, "bash": true }
  }
}

// 4xx — request shape problem (missing workspace_id, etc.)
// 5xx — orchestrator-internal failure unrelated to the agent
```

**Prerequisites.** RT-DIAG-4.

**Independent.** No.

**Validation.**
- Endpoint test: happy path → 200 + `status: "ready"`.
- Endpoint test: agent with missing credential → 200 + `status:
  "not_ready"`, `reason: "credential_missing"`.
- Endpoint test: missing `workspace_id` query param → 400.
- Endpoint test: unauthenticated → 401 (or whatever the existing
  internal-endpoint auth model returns).

### 🟡 RT-DIAG-6: probe batch endpoint for whole-workspace queries

**Branch:** `feat/rt-diag-workspace-probe-endpoint`

**What.** New route:
`GET /api/v1/diagnostic/workspace/:workspace_id/agents`.

Returns probe results for every agent in the workspace, run
concurrently. Avoids the platform having to fan out one HTTP call per
agent on workspace-open.

| Constraint | Default | Why |
|---|---|---|
| Concurrency cap | 5 | Bounds load on Supabase + downstream runners when a workspace has many agents |
| Per-agent timeout | 10s | A single broken agent can't hang the batch |
| Aggregate timeout | 30s | Whole batch returns even if some probes time out |

Timed-out probes appear in the response with `status: "timeout"` and
no `details` — same JSON shape as RT-DIAG-5 otherwise.

**Response shape:**

```json
{
  "workspace_id": "uuid",
  "agents": [
    { "agent_id": "uuid-a", "status": "ready" },
    { "agent_id": "uuid-b", "status": "not_ready", "reason": "credential_missing", "details": {...} },
    { "agent_id": "uuid-c", "status": "timeout" }
  ]
}
```

**Prerequisites.** RT-DIAG-5.

**Independent.** No.

**Validation.**
- Endpoint test: workspace with three agents (one ready, one broken,
  one timing out via a controllable runner stub) → response matches
  the three-row shape above.
- Endpoint test: workspace with zero agents → `{"agents": []}`.
- Concurrency assertion: instrument the runner stub to count
  simultaneous probe calls; assert it never exceeds the cap.

## Cross-repo dependencies

| This repo PR | Unblocks in platform |
|---|---|
| RT-DIAG-1 | (nothing on the platform — pure runtime hygiene) |
| RT-DIAG-2 | (nothing on the platform — fire-fight) |
| RT-DIAG-3 | (nothing on the platform — internal observability) |
| RT-DIAG-4 | (nothing on the platform — internal module) |
| RT-DIAG-5 | PLAT-DIAG-1 (platform's proxy endpoint can call this) |
| RT-DIAG-6 | PLAT-DIAG-1 (platform uses the batch shape on workspace-open) |

RT-DIAG-1 / 2 / 3 are independent and can land in parallel.
RT-DIAG-5 + RT-DIAG-6 together fully unblock the platform side.

## Reference

- Crash site: `apps/orchestrator/lib/symphony_elixir/codex/app_server.ex:198-221`
  (`Codex.AppServer.start_port` — spawns `bash -lc "<codex_command>"`)
- Container build: `apps/orchestrator/deploy/Dockerfile` (apt install
  list at lines 50-61 — `codex` is absent)
- Logging convention reference:
  `apps/orchestrator/lib/symphony_elixir/agent_runner.ex:40` and
  surrounding `RuntimeLog.log/3` calls
- Web layer (route lives here):
  `apps/orchestrator/lib/symphony_elixir_web/router.ex`
- Manager smoke runbook (downstream beneficiary of RT-DIAG-2):
  [`manager-agent-smoke-runbook.md`](./manager-agent-smoke-runbook.md)
- Platform companion scope:
  [`parallel-agent-platform/docs/active/agent-health-diagnostic-pr-plan.md`](../../../parallel-agent-platform/docs/active/agent-health-diagnostic-pr-plan.md)

## Out of scope for this plan

- Implementing the PRs themselves (this doc is scope-only).
- Platform-side UI / proxy endpoint (lives in the platform companion).
- Auto-remediation of detected failures — the probe and inventory only
  report; nothing in this plan attempts to repair a broken agent.
- Generalizing the probe to non-runner subsystems (DB connectivity,
  Supabase reachability, etc.). The probe is *per-agent* by design.
