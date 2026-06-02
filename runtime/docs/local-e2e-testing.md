# Local End-to-End Testing Guide

Two options for validating the full issue → worker → result flow locally. Option A exercises real external services; Option B is a faster launcher smoke test that pushes work items over HTTP.

---

## Option A — Live end-to-end (Linear + Codex)

Full-fidelity test that creates a real Linear project/issue, spins up workers, runs Codex, and verifies the issue is closed with the expected workspace side effects. This is the only path that proves Linear polling, the Codex app-server handshake, and workspace cleanup all work together.

### What it exercises

- Launcher → Orchestrator spawn
- Linear GraphQL polling (`tracker/linear.ex`)
- Dispatcher concurrency gating
- Codex app-server session lifecycle
- Workspace creation + cleanup on terminal state
- OTP `DOWN` monitoring of runner processes (`orchestrator.ex:118`)

### Prerequisites

1. **Linear account** with a team keyed `SYME2E` (see `@default_team_key` in `live_e2e_test.exs:10`). Team needs standard workflow states.
2. **Linear API key** — Settings → Security & access → Personal API keys.
3. **Codex binary** on `PATH` and auth at `~/.codex/auth.json`.
4. **Docker** (optional) — only if you want the multi-worker path from `apps/orchestrator/test/support/live_e2e_docker/docker-compose.yml`.
5. **Elixir/Erlang** via `mise install` (see `apps/orchestrator/README.md:49`).

### Run it

```bash
export LINEAR_API_KEY=lin_api_...
export SYMPHONY_RUN_LIVE_E2E=1
pnpm run test:e2e
```

Under the hood this runs:

```bash
mix test test/symphony_elixir/live_e2e_test.exs
```

### What happens, step by step

1. Test queries Linear for team `SYME2E` and its workflow states.
2. Creates a fresh project named after the test run (`projectCreate` mutation at `live_e2e_test.exs:40`).
3. Creates an issue in that project (`issueCreate` mutation at line 53).
4. Starts the orchestrator pointed at that project slug + a workflow file.
5. Orchestrator's polling loop (`orchestrator.ex:73-116`) picks up the issue.
6. Dispatcher launches a Codex runner in a fresh workspace.
7. Codex executes the workflow prompt, writes `LIVE_E2E_RESULT.txt` (see `@result_file` at line 15) as proof of side effects.
8. Workflow moves the issue to a terminal state (Done/Closed).
9. Orchestrator detects terminal state, stops the agent, cleans up the workspace.
10. Test asserts: file exists, issue is in terminal state, workspace is gone.

### When to use it

- Before merging changes to tracker adapters, runners, or the dispatcher.
- In CI on a nightly cadence (it takes ~several minutes and costs Linear + OpenAI quota).
- **Not** for inner-loop iteration — too slow and has external dependencies.

---

## Option B — Faster local loop (Launcher + API tracker)

Skips Linear and drives the launcher/orchestrator stack with pushed work items over HTTP. This is useful for validating launcher startup, orchestrator spawn, workspace creation, and agent dispatch without provisioning external tracker data, but it still uses a real Codex session.

### What it exercises

- Launcher HTTP API on `:4100`
- Orchestrator spawn + config validation
- API tracker ingestion via `POST /api/v1/items`
- Polling loop picks up pushed items from a tracker
- Workspace creation + local agent dispatch
- Runner process lifecycle (`spawn`, `DOWN` handling, retries)

### What it does NOT exercise

- Real Linear API behavior (rate limits, GraphQL quirks)
- Hermetic/mock runner execution
- Automatic tracker-side completion or issue closing
- Network partitions / auth failures with external services

### Prerequisites

- Elixir/Erlang (`mise install`)
- Codex binary on `PATH` and auth at `~/.codex/auth.json`

### Implementation

#### 1. Start the launcher

```bash
cd apps/orchestrator
mise exec -- mix launcher.start
```

Launcher listens on `:4100`. Endpoint: `POST /orchestrators` with a JSON config body.

#### 2. Start an orchestrator with `tracker.kind: "api"`

```bash
curl -X POST http://localhost:4100/orchestrators \
  -H 'content-type: application/json' \
  -d '{
    "name": "e2e-local",
    "port": 4000,
    "tracker": {
      "kind": "api"
    },
    "workspace": {
      "root": "/tmp/symphony-local-e2e"
    },
    "agent": {
      "max_concurrent_agents": 1,
      "max_turns": 1
    },
    "prompt": "Create a file named LOCAL_E2E_RESULT.txt in the workspace containing the issue identifier and the text local launcher smoke test."
  }'
```

The launcher currently serializes `tracker`, `workspace`, `agent`, and `prompt` into the generated workflow. It does **not** accept a launcher-level mock runner or polling override, so this path is a fast launcher smoke test, not a hermetic mock-runner loop.

#### 3. Inject an issue

API-tracked work items are pushed to the orchestrator's HTTP API on the orchestrator port:

```bash
curl -X POST http://localhost:4000/api/v1/items \
  -H 'content-type: application/json' \
  -d '{
    "id": "ISSUE-1",
    "title": "Test issue",
    "description": "Make the agent create LOCAL_E2E_RESULT.txt in its workspace."
  }'
```

#### 4. Observe

- Orchestrator dashboard: `http://localhost:4000` (Phoenix LiveView)
- State API: `curl http://localhost:4000/api/v1/state`
- Assert: the work item appears under `running`, `workspace_path` is populated, and `LOCAL_E2E_RESULT.txt` exists in that workspace.

Because the API tracker has no external source-of-truth to close, this loop does not automatically move the item to a terminal state. Use Option A when you need end-to-end completion and cleanup against a real tracker.

### Scripted version

Write a shell script (e.g. `scripts/e2e-local.sh`) that:

1. Starts the launcher in the background (`cd apps/orchestrator && mise exec -- mix launcher.start &`).
2. Waits for `:4100` to accept connections.
3. `POST`s the orchestrator config.
4. `POST`s one or more test items to `/api/v1/items`.
5. Polls `/api/v1/state` until the target item shows up under `running` and the workspace proof file exists, or times out.
6. Kills the launcher and reports pass/fail.

This gives you a single command (`./scripts/e2e-local.sh`) for pre-commit validation.

### When to use it

- Every time you touch orchestrator, launcher, dispatcher, or tracker code.
- As a smoke test for launcher/orchestrator wiring before you spend quota on Linear-backed E2E.
- While debugging runner startup or workspace-creation issues without involving Linear.

---

## Recommended workflow

1. **Inner loop**: run Option B while iterating on launcher/orchestrator wiring.
2. **Pre-merge**: run Option A locally when touching tracker adapters, runners, or anything that crosses a process boundary.
3. **CI**:
   - PR check: Option B if you want a lightweight launcher smoke test with real Codex.
   - Nightly: Option A (minutes, external quota).

## Key files

- `apps/orchestrator/test/symphony_elixir/live_e2e_test.exs` — Option A implementation.
- `apps/orchestrator/test/support/live_e2e_docker/docker-compose.yml` — multi-worker Docker setup for Option A.
- `apps/orchestrator/lib/symphony_elixir/orchestrator.ex:73-118` — polling loop + `DOWN` handling.
- `apps/orchestrator/lib/symphony_elixir/tracker/api.ex` — push-based tracker used in Option B.
- `apps/orchestrator/lib/symphony_elixir/launcher/` — launcher HTTP API on `:4100`.
- `apps/orchestrator/lib/mix/tasks/launcher_start.ex` — `mix launcher.start` entrypoint.
- `package.json` — `start:orchestrator`, `start:orchestrator:watch`, `test:e2e` scripts.
