# Launcher Architecture and Cross-Repo Integration

This document describes how the orchestrator runtime (this repo) integrates with the API server
and web client (separate repo) via a Launcher process. It is the shared reference for both repos.

## System overview

Three processes, two repos, one user.

```
                         OTHER REPO
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  Web Client (React)              API Server (Node/Bun)   │
│  :5173                           :3100                   │
│  VITE_BROKER_BASE ──────────────▶                        │
│                                  /api/agents/* ──proxy──▶│
│  - Setup wizard                  /health       ──proxy──▶│
│  - Dashboard views               /ws           ──proxy──▶│
│  - Auth (Supabase)               User config (Supabase)  │
│                                                          │
└──────────────────────────────────┬───────────────────────┘
                                   │
                                   │ LAUNCHER_BASE_URL
                                   │ http://127.0.0.1:4100
                                   │
┌──────────────────────────────────┼───────────────────────┐
│                    THIS REPO     │                       │
│                                  ▼                       │
│  ┌───────────────────────────────────────────────┐       │
│  │              Launcher                         │       │
│  │              :4100                            │       │
│  │                                               │       │
│  │  POST   /orchestrators      (start one)       │       │
│  │  DELETE /orchestrators/:id  (stop one)         │       │
│  │  GET    /orchestrators      (list running)     │       │
│  │  GET    /orchestrators/:id  (status + port)    │       │
│  │                                               │       │
│  │  DynamicSupervisor                            │       │
│  │    ├── Orchestrator A (:4000)                 │       │
│  │    │     └── agents working on repo-A         │       │
│  │    ├── Orchestrator B (:4001)                 │       │
│  │    │     └── agents working on repo-B         │       │
│  │    └── ...                                    │       │
│  └───────────────────────────────────────────────┘       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## Process responsibilities

### Web Client (other repo)

Owns the user experience. Never talks to the launcher or orchestrator directly.

- Setup wizard: repo URL, Linear project, workflow template selection
- Dashboard: agent status, running sessions, retries, token usage
- Auth: Supabase login, JWT tokens
- All requests go through the API server at `VITE_BROKER_BASE`

### API Server (other repo)

Owns user identity, config persistence, and orchestrator lifecycle decisions. Acts as a proxy
and control plane bridge.

- Persists user config (repo URL, Linear token, workflow template) in Supabase
- Calls the Launcher API to start/stop orchestrators
- Stores the mapping: `user_id -> { orchestrator_id, port }`
- Proxies dashboard requests to the correct orchestrator port
- Passes through WebSocket connections for live updates
- Does **not** manage processes directly — delegates to the Launcher

### Launcher (this repo)

Owns process supervision and orchestrator lifecycle. Always running. No concept of users or auth.

- Starts orchestrator instances under OTP DynamicSupervisor
- Assigns ports automatically (4000, 4001, 4002, ...)
- Restarts crashed orchestrators via OTP supervision
- Exposes a management API on `:4100` for the API server to call
- Persists running orchestrator configs to survive its own restart
- Each orchestrator is a full independent instance with its own WORKFLOW.md, repo, tracker config

### Orchestrator (this repo, existing)

Owns work execution. Headless runtime, no concept of users, launcher, or API server.

- Receives all config at startup (WORKFLOW.md + CLI args + env vars)
- Polls Linear, dispatches agents, manages workspaces, handles retries
- Exposes read-only API on its assigned port (`/api/v1/health`, `/api/v1/state`, etc.)
- Unchanged from current implementation

## Startup sequence

### New user setup (first time)

```
1.  Launcher is already running on :4100 (started on deploy / boot)
2.  User opens web client → setup wizard
3.  User enters:
      - Repository URL (e.g., https://github.com/org/repo)
      - Linear API key
      - Linear project slug
      - Workflow template choice (coding, marketing, etc.)
4.  Web client → API server: POST /api/setup
5.  API server persists config to Supabase
6.  API server → Launcher: POST /orchestrators
      {
        "repository": "https://github.com/org/repo",
        "linear_api_key": "lin_api_...",
        "linear_project_slug": "my-project-abc",
        "workflow_template": "coding"
      }
7.  Launcher:
      - Selects next available port (e.g., 4000)
      - Resolves workflow template to a WORKFLOW.md path
      - Starts orchestrator under DynamicSupervisor with config
      - Returns: { "id": "orch_abc123", "port": 4000 }
8.  API server stores orchestrator_id + port for this user
9.  API server starts proxying /api/agents/* → localhost:4000/api/v1/*
10. Web client switches to dashboard view
11. Orchestrator picks up Linear issues and starts working
```

### Returning user

```
1. Launcher is running, orchestrator is already supervised and alive
2. User opens web client → API server looks up orchestrator_id + port
3. API server proxies to the running orchestrator
4. Dashboard shows current state immediately
```

### Config update (user changes repo or Linear project)

```
1. User updates config in web client
2. Web client → API server: PUT /api/setup
3. API server persists new config to Supabase
4. API server → Launcher: DELETE /orchestrators/:id (stop old)
5. API server → Launcher: POST /orchestrators (start new with updated config)
6. API server updates stored orchestrator_id + port
```

Config changes require an orchestrator restart. This is intentional — the orchestrator is a
stateless runtime that receives config at startup. Mutable config lives in Supabase, managed
by the API server.

### Launcher restart recovery

```
1. Launcher persists active orchestrator configs to disk (or DB) on each start/stop
2. On boot, Launcher reads persisted configs and re-starts all orchestrators
3. API server health-checks orchestrator ports; if port changed, Launcher
   GET /orchestrators/:id returns the new port
```

## Launcher API contract

Base URL: `LAUNCHER_BASE_URL` (default `http://127.0.0.1:4100`)

### POST /orchestrators

Start a new orchestrator instance.

Request:
```json
{
  "repository": "https://github.com/org/repo",
  "linear_api_key": "lin_api_...",
  "linear_project_slug": "my-project-abc",
  "linear_assignee": "user@example.com",
  "workflow_template": "coding",
  "max_concurrent_agents": 10
}
```

Response `201`:
```json
{
  "id": "orch_abc123",
  "port": 4000,
  "status": "starting"
}
```

### GET /orchestrators

List all running orchestrator instances.

Response `200`:
```json
{
  "orchestrators": [
    {
      "id": "orch_abc123",
      "port": 4000,
      "status": "running",
      "repository": "https://github.com/org/repo",
      "project_slug": "my-project-abc",
      "started_at": "2026-04-13T10:00:00Z"
    }
  ]
}
```

### GET /orchestrators/:id

Get status of a specific orchestrator.

Response `200`:
```json
{
  "id": "orch_abc123",
  "port": 4000,
  "status": "running",
  "repository": "https://github.com/org/repo",
  "project_slug": "my-project-abc",
  "started_at": "2026-04-13T10:00:00Z",
  "pid": 12345
}
```

### DELETE /orchestrators/:id

Stop an orchestrator instance. Graceful shutdown with workspace cleanup.

Response `200`:
```json
{
  "id": "orch_abc123",
  "status": "stopped"
}
```

## Proxy routing (API server responsibility)

The API server maps incoming requests to the correct orchestrator port:

```
Client request                     API server routes to
──────────────────────────────────────────────────────────
GET  /api/agents                →  GET  localhost:{port}/api/v1/state
GET  /api/agents/:identifier   →  GET  localhost:{port}/api/v1/:identifier
POST /api/agents/refresh       →  POST localhost:{port}/api/v1/refresh
GET  /health                   →  GET  localhost:{port}/api/v1/health
WS   /ws                       →  WS   localhost:{port}/ws (pass-through)
```

The `{port}` is resolved from the user's stored `orchestrator_id` → Launcher lookup.

## Environment variables

### Launcher process (this repo)

| Variable | Default | Description |
|---|---|---|
| `LAUNCHER_PORT` | `4100` | Port for the Launcher management API |
| `LAUNCHER_BIND_HOST` | `127.0.0.1` | Bind address for the Launcher API. Use `0.0.0.0` only behind a private listener. |
| `LAUNCHER_STATE_DIR` | `~/.symphony/launcher` | Where to persist orchestrator configs for restart recovery |

### Per-orchestrator (set by Launcher at spawn time)

| Variable | Source | Description |
|---|---|---|
| `LINEAR_API_KEY` | Launcher API request | Linear API token for this orchestrator |
| `LINEAR_ASSIGNEE` | Launcher API request | Optional assignee filter |
| `PORT` | Launcher-assigned | Port for this orchestrator's API |

### API server (other repo)

| Variable | Default | Description |
|---|---|---|
| `LAUNCHER_BASE_URL` | `http://127.0.0.1:4100` | Where to reach the Launcher API |
| `SUPABASE_URL` | — | Supabase project URL for user config persistence |
| `SUPABASE_ANON_KEY` | — | Supabase anonymous key |

### Web client (other repo)

| Variable | Default | Description |
|---|---|---|
| `VITE_BROKER_BASE` | `http://127.0.0.1:3100` | API server base URL |

## Local development

All three processes run on localhost:

```bash
# Terminal 1: Launcher (this repo)
# Starts on :4100, manages orchestrators on :4000+
mix launcher.start

# Terminal 2: API server (other repo)
# Starts on :3100, proxies to launcher and orchestrators
LAUNCHER_BASE_URL=http://127.0.0.1:4100 pnpm run dev

# Terminal 3: Web client (other repo)
# Starts on :5173, talks to API server
VITE_BROKER_BASE=http://127.0.0.1:3100 pnpm run dev
```

No orchestrators are running yet. They start when a user completes setup in the web client,
which triggers the API server to call `POST /orchestrators` on the Launcher.

## AWS deployment

```
                    ┌────────────────────────┐
                    │     Route 53 / ALB     │
                    └──────────┬─────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
     ┌──────────────┐  ┌─────────────┐  ┌──────────────┐
     │  Web Client  │  │ API Server  │  │   Launcher   │
     │  (S3/CF)     │  │ (ECS Svc)   │  │  (ECS Svc)   │
     │              │  │  :3100      │  │   :4100      │
     └──────────────┘  └──────┬──────┘  └──────┬───────┘
                              │                │
                              │   internal     │ DynamicSupervisor
                              │   network      │ (in-process)
                              │                │
                              │         ┌──────┴───────┐
                              └────────▶│ Orch A :4000 │
                                        │ Orch B :4001 │
                                        │ ...          │
                                        └──────────────┘
                                               │
                                        ┌──────┴───────┐
                                        │  SSM/Secrets │
                                        │  Manager     │
                                        └──────────────┘
```

- **Web Client**: Static build in S3 + CloudFront
- **API Server**: ECS Fargate service, persistent, auto-scaling
- **Launcher**: ECS Fargate service, single task, persistent
  - Runs orchestrators as supervised processes within the same Beam VM
  - For heavier isolation: Launcher calls ECS RunTask per orchestrator instead
- **Secrets**: Linear API keys, Supabase keys in SSM Parameter Store / Secrets Manager
- **Communication**: API server → Launcher via internal ALB or service discovery (Cloud Map)

### Scaling decision: in-process vs separate ECS tasks

**Start with in-process** (orchestrators as supervised children in the Launcher Beam VM):
- Simpler. One ECS task runs everything.
- OTP supervision handles crashes and restarts for free.
- Fine for up to ~50 concurrent orchestrators (the bottleneck is Codex subprocesses, not the Beam).

**Move to separate ECS tasks** when:
- A single orchestrator's Codex agents need more CPU/memory than the Launcher task allows.
- You need per-user resource isolation for billing or security.
- You're running 100+ orchestrators and want independent scaling.

The Launcher API contract stays identical in both modes. Only the internal implementation
of "start an orchestrator" changes (DynamicSupervisor.start_child vs ECS RunTask).

## Generic input model

The orchestrator must accept work from any source — not just Linear. The current tracker
abstraction (`SymphonyElixir.Tracker` behavior) is already adapter-based, but the data model
and config are Linear-specific. This section defines the generic input contract.

### Work item (replaces Linear Issue)

Every input source produces the same normalized struct. This is the only shape the orchestrator,
agent runner, prompt builder, and workspace manager see.

```
WorkItem
├── id              (string)     Unique ID from the source system
├── identifier      (string)     Human-readable key ("PROJ-123", "GH-45", "task_abc")
├── title           (string)     Short summary
├── description     (string)     Full body / instructions
├── state           (string)     Current state name ("todo", "in_progress", "done")
├── priority        (integer)    Numeric priority (lower = higher priority)
├── url             (string)     Link back to the source (Linear URL, GitHub issue URL, etc.)
├── labels          ([string])   Tags / labels for routing and filtering
├── source          (string)     Which adapter created this ("linear", "api", "github", "db")
├── metadata        (map)        Source-specific fields (branch_name, assignee_id, blocked_by, etc.)
├── assigned_to_worker (boolean) Whether this item is assigned to this orchestrator instance
├── created_at      (DateTime)
└── updated_at      (DateTime)
```

The `metadata` map holds source-specific fields that don't belong in the core struct.
Adapters put things like `branch_name`, `assignee_id`, `blocked_by` there. The prompt
template can access them via `{{ item.metadata.branch_name }}`.

### Input sources

```
                                    ┌───────────────┐
  Linear ──── poll ────────────────▶│               │
                                    │               │
  GitHub Actions ── webhook ──────▶│   Tracker     │──── [WorkItem] ──── Orchestrator
                                    │   Adapter     │
  API call ── POST /items ────────▶│   Router      │
                                    │               │
  Database ── poll ───────────────▶│               │
                                    └───────────────┘
```

#### 1. Linear (existing, poll-based)

Current behavior, wrapped to produce `WorkItem` instead of `Linear.Issue`.
Configured via `tracker.kind: linear` in WORKFLOW.md. Polls on interval.

#### 2. Database / Supabase (poll-based)

The API server in the other repo manages plans and tasks in Supabase. The orchestrator
polls a table (or view) for work items in active states.

```yaml
# WORKFLOW.md
tracker:
  kind: database
  endpoint: "https://xyz.supabase.co/rest/v1"
  api_key: $SUPABASE_SERVICE_KEY
  table: work_items
  active_states: [todo, in_progress]
  terminal_states: [done, cancelled]
  poll_interval_ms: 5000
```

The adapter queries the table, maps rows to `WorkItem`, and returns them. Write operations
(state updates, comments) go back to the same table/API.

This is the primary integration point with the other repo's data model. The API server
writes plans/tasks to Supabase; the orchestrator reads them as work items.

#### 3. API push (webhook/event-based)

The Launcher (or orchestrator) exposes an endpoint that accepts work items directly.
No polling — the caller pushes items in.

```
POST /api/v1/items
{
  "identifier": "deploy-2026-04-13",
  "title": "Deploy staging",
  "description": "Run the staging deploy pipeline...",
  "state": "todo",
  "labels": ["devops"],
  "source": "api"
}
```

Use cases:
- GitHub Actions workflow calls the orchestrator to run a task
- API server pushes a task directly instead of writing to DB and waiting for poll
- CI/CD pipelines, cron jobs, or any external system

The orchestrator treats pushed items the same as polled items — they enter the dispatch
queue, get a workspace, and run through the agent lifecycle.

#### 4. GitHub (webhook-based)

GitHub issues, PR review requests, or Actions workflow dispatches arrive as webhooks.
A thin adapter normalizes GitHub's payload to `WorkItem`.

```yaml
tracker:
  kind: github
  repository: "org/repo"
  api_key: $GITHUB_TOKEN
  active_states: [open]
  terminal_states: [closed]
  webhook_secret: $GITHUB_WEBHOOK_SECRET
```

The adapter can work in poll mode (query GitHub Issues API) or push mode (receive
webhooks at an endpoint the Launcher exposes).

### Tracker adapter contract

The existing `SymphonyElixir.Tracker` behavior stays the same, but adapters return
`WorkItem` instead of `Linear.Issue`:

```elixir
@callback fetch_candidate_issues() :: {:ok, [WorkItem.t()]} | {:error, term()}
@callback fetch_issues_by_states([String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
@callback fetch_issue_states_by_ids([String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
@callback create_comment(String.t(), String.t()) :: :ok | {:error, term()}
@callback update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
```

For push-based sources (API, GitHub webhooks), the adapter also implements:

```elixir
@callback accept_item(map()) :: {:ok, WorkItem.t()} | {:error, term()}
```

Pushed items are held in the adapter's internal state and returned by
`fetch_candidate_issues/0` on the next poll cycle, so the orchestrator's
dispatch loop doesn't change.

### Adapter routing

The tracker config determines which adapter handles work:

```elixir
# Current (hardcoded)
def adapter do
  case Config.settings!().tracker.kind do
    "memory"   -> SymphonyElixir.Tracker.Memory
    "linear"   -> SymphonyElixir.Linear.Adapter
  end
end

# Target (extensible)
def adapter do
  case Config.settings!().tracker.kind do
    "memory"   -> SymphonyElixir.Tracker.Memory
    "linear"   -> SymphonyElixir.Tracker.Linear
    "database" -> SymphonyElixir.Tracker.Database
    "github"   -> SymphonyElixir.Tracker.GitHub
    "api"      -> SymphonyElixir.Tracker.API
  end
end
```

### How sources combine

A single orchestrator instance uses one tracker adapter. To combine sources (e.g., Linear
issues AND API-pushed tasks), use the database adapter as the integration point:

```
Linear issues ──┐
                 ├──▶ Supabase work_items table ──▶ Database adapter ──▶ Orchestrator
API pushes ─────┤
GitHub hooks ───┘
```

The API server (other repo) is responsible for normalizing external sources into the
shared `work_items` table. The orchestrator only reads from one place.

Alternatively, a future `composite` adapter could poll multiple sources and merge results,
but the database approach is simpler and more reliable.

### Launcher API update for generic input

The `POST /orchestrators` request accepts a generic `tracker` config instead of
Linear-specific fields:

```json
{
  "repository": "https://github.com/org/repo",
  "workflow_template": "coding",
  "max_concurrent_agents": 10,
  "tracker": {
    "kind": "database",
    "endpoint": "https://xyz.supabase.co/rest/v1",
    "api_key": "...",
    "table": "work_items",
    "active_states": ["todo", "in_progress"],
    "terminal_states": ["done", "cancelled"]
  }
}
```

Or for Linear with multiple runner types:

```json
{
  "repository": "https://github.com/org/repo",
  "workflow_template": "coding",
  "tracker": {
    "kind": "linear",
    "api_key": "lin_api_...",
    "project_slug": "my-project-abc"
  },
  "runners": {
    "default": "codex",
    "codex": {
      "command": "codex --config ... app-server",
      "approval_policy": "never"
    },
    "openclaw": {
      "base_url": "https://openclaw.local:8080",
      "api_key": "..."
    },
    "computer_use": {
      "endpoint": "https://cua.internal:9090",
      "api_key": "..."
    }
  }
}
```

### Migration path (what changes in this repo)

1. **Rename `Linear.Issue` to `SymphonyElixir.WorkItem`** — move out of the Linear namespace.
   Keep all existing fields. Add `source` and `metadata` fields.
   Update all 8 files that reference `Linear.Issue`.

2. **Move `Linear.Adapter` to `Tracker.Linear`** — consistent with other adapters.
   Keep all existing behavior.

3. **Add `Tracker.Database` adapter** — polls a Supabase/Postgres table via REST API.
   Maps rows to `WorkItem`. Implements state updates and comments via the same API.

4. **Add `Tracker.API` adapter** — holds a GenServer with an in-memory queue.
   Accepts items via `accept_item/1`. Returns them from `fetch_candidate_issues/0`.
   The Launcher or orchestrator HTTP server exposes `POST /api/v1/items` that calls this.

5. **Update `Tracker` router** — add new adapter kinds.

6. **Update prompt templates** — change `{{ issue.* }}` to `{{ item.* }}` in default templates
   (or keep `issue` as an alias for backward compatibility).

## Worker types and runner abstraction

Today, "agent" means one thing: a Codex subprocess running in a git workspace on the same
machine (or over SSH). But the orchestrator needs to dispatch work to fundamentally different
execution environments:

```
Orchestrator
  │
  │ dispatch(work_item, runner_type)
  │
  ├──▶ Runner.Codex          Local/SSH subprocess, git workspace, code execution
  │      └── Codex app-server process (stdin/stdout JSON-RPC)
  │
  ├──▶ Runner.OpenClaw        HTTP API to user's OpenClaw instance
  │      └── POST /v1/runs → poll /v1/runs/:id → completion
  │
  ├──▶ Runner.ComputerUse     API to a computer use agent (desktop/browser control)
  │      └── POST /sessions → stream actions → completion
  │
  └──▶ Runner.Custom          Future: any execution backend behind the Runner contract
```

### Runner behavior contract

Every worker type implements the same interface. The orchestrator doesn't know or care
what's behind it — it calls the same four functions:

```elixir
defmodule SymphonyElixir.Runner do
  @callback start_session(config :: map(), workspace :: String.t() | nil)
            :: {:ok, session :: map()} | {:error, term()}

  @callback run_turn(session :: map(), prompt :: String.t(), work_item :: WorkItem.t())
            :: {:ok, result :: map()} | {:error, term()}

  @callback stop_session(session :: map())
            :: :ok | {:error, term()}

  @callback ping(config :: map())
            :: :ok | {:error, term()}
end
```

### Runner types

#### Codex (existing behavior, extracted)

- **Execution model**: Local subprocess or SSH remote subprocess
- **Workspace**: Required. Git clone into per-item directory.
- **Communication**: JSON-RPC over stdin/stdout with the Codex app-server process
- **Lifecycle**: Orchestrator spawns process, runs turns, kills process on completion
- **Config**: `codex.command`, sandbox policy, approval policy

```yaml
runner:
  type: codex
  command: "codex --config ... app-server"
  approval_policy: never
  thread_sandbox: workspace-write
```

#### OpenClaw

- **Execution model**: HTTP API calls to a remote OpenClaw instance
- **Workspace**: Optional. OpenClaw may manage its own workspace, or orchestrator
  provides a workspace reference.
- **Communication**: REST API — start run, poll status, retrieve results
- **Lifecycle**: Orchestrator sends HTTP request, polls for completion, retrieves artifacts
- **Config**: Base URL, API key, model, timeout

```yaml
runner:
  type: openclaw
  base_url: "https://openclaw.local:8080"
  api_key: $OPENCLAW_API_KEY
  model: "o4-mini"
  timeout_ms: 300000
```

The orchestrator calls `POST /v1/runs` with the work item and prompt, then polls
`GET /v1/runs/:id` until terminal. Results map to the same outcome types
(completed, failed, timed out) that drive the retry logic.

#### Computer Use

- **Execution model**: API calls to a computer use agent service
- **Workspace**: None. The agent operates on a remote desktop/browser session.
- **Communication**: REST/WebSocket API — start session, stream actions, observe results
- **Lifecycle**: Orchestrator opens a session, sends the task, monitors progress,
  closes session on completion
- **Config**: API endpoint, auth, session type (desktop, browser), timeout

```yaml
runner:
  type: computer_use
  endpoint: "https://cua.internal:9090"
  api_key: $CUA_API_KEY
  session_type: browser
  timeout_ms: 600000
```

The agent controls a virtual desktop or browser to complete tasks — filling forms,
navigating UIs, testing web apps. Work items routed here would typically be QA tasks,
data entry, or UI testing.

#### Mock (for tests)

- Returns preconfigured responses. No external calls.
- Used in integration tests to verify orchestrator behavior without real providers.

### How routing works

Each work item gets routed to a runner based on configuration. Three levels of routing,
evaluated in order:

```
1. Work item label     →  labels: ["runner:computer_use"]  →  Runner.ComputerUse
2. Workflow config     →  runner.type: openclaw             →  Runner.OpenClaw
3. Default             →  runner.default: codex             →  Runner.Codex
```

A single orchestrator can dispatch to multiple runner types simultaneously. One work item
goes to Codex for coding, another goes to Computer Use for QA, another goes to OpenClaw
for a different model — all managed by the same dispatch loop, retry logic, and
state machine.

### What changes in the orchestrator

The `AgentRunner` currently calls `AppServer` (Codex) directly. The refactor:

```
Before:
  AgentRunner.run(issue)
    → Workspace.create_for_issue(issue)
    → AppServer.start_session(workspace)        ← Codex-specific
    → AppServer.run_turn(session, prompt)        ← Codex-specific
    → AppServer.stop_session(session)            ← Codex-specific

After:
  AgentRunner.run(work_item)
    → runner = resolve_runner(work_item)         ← picks Codex, OpenClaw, CUA, etc.
    → maybe create workspace (if runner needs one)
    → runner.start_session(config, workspace)    ← generic
    → runner.run_turn(session, prompt, item)     ← generic
    → runner.stop_session(session)               ← generic
```

The orchestrator's dispatch loop, retry logic, state reconciliation, and workspace
management stay unchanged. Only the `AgentRunner` layer gains a runner resolution step.

### What this means for the data model

Work items need a `runner_type` field (or it's inferred from labels/config):

```
tasks (work_items)
├── ...existing fields...
├── runner_type         (codex, openclaw, computer_use, null for default)
├── runner_config       (jsonb — runner-specific overrides)
└── ...
```

The `orchestrators` table also tracks which runner types are available:

```
orchestrators
├── ...existing fields...
├── runner_types        (text[] — ["codex", "openclaw", "computer_use"])
└── runner_configs      (jsonb — per-type config like base URLs, API keys)
```

## Data model and storage

### Where state lives

There are three categories of state, each stored differently:

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Supabase (other repo owns)                       │
│                                                                      │
│  users              │ id, email, auth metadata                       │
│  projects           │ id, user_id, name, repo_url, workflow_template │
│  project_tracker    │ project_id, tracker_kind, api_key, slug, etc.  │
│  orchestrators      │ id, project_id, status, port, started_at       │
│  plans              │ id, project_id, title, description, state       │
│  tasks (work_items) │ id, plan_id, title, description, state,        │
│                     │ priority, labels, source, metadata              │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                     Launcher state (this repo)                       │
│                                                                      │
│  ~/.symphony/launcher/orchestrators.json                             │
│  [{ id, port, pid, config_hash, started_at }]                        │
│                                                                      │
│  Minimal. Just enough to restart orchestrators after Launcher reboot.│
│  Source of truth for "what's actually running right now."             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                     Orchestrator state (this repo, in-memory)        │
│                                                                      │
│  GenServer state in SymphonyElixir.Orchestrator                      │
│  - running: %{issue_id => {pid, ref, workspace, session, ...}}       │
│  - retrying: %{issue_id => {attempt, timer, ...}}                    │
│  - claimed: MapSet of issue IDs                                      │
│  - token counters, rate limits                                       │
│                                                                      │
│  Ephemeral. Lost on restart. Rebuilt from tracker on next poll.       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Orchestrator records: database, not local file

Orchestrator records belong in Supabase, not just the Launcher's local file. Here's why:

- The API server needs to know which orchestrators exist, what port they're on, and whether
  they're healthy — for proxy routing and the dashboard.
- The Launcher's local file is a crash-recovery mechanism, not a source of truth.
- When scaling to multiple Launcher instances (multi-region, or ECS task replacement),
  the local file doesn't follow.

**Flow:**

```
1. API server writes orchestrator record to Supabase:
     INSERT INTO orchestrators (project_id, status) VALUES (..., 'requested')
2. API server calls Launcher: POST /orchestrators { id: "orch_abc", config: {...} }
3. Launcher starts the process, updates its local state
4. Launcher responds with { id, port, status: "running" }
5. API server updates Supabase: UPDATE orchestrators SET status='running', port=4000
```

The Launcher also writes to its local file for crash recovery, but the database is
the system of record. On Launcher restart:

```
1. Launcher reads local file: "I was running orch_abc on port 4000"
2. Launcher re-starts orchestrator on port 4000
3. API server health-checks the port, confirms it's alive
4. If the local file is lost, API server can re-issue POST /orchestrators
   for any orchestrators in Supabase with status='running'
```

### Plans and tasks (the work items)

The other repo's data model has plans and tasks. A plan is a group of related tasks
(like a project or epic). A task is an individual work item an agent picks up.

```
plans
├── id
├── project_id → projects.id
├── title
├── description
├── state (draft, active, completed)
├── created_at
└── updated_at

tasks (work_items)
├── id
├── plan_id → plans.id (nullable — standalone tasks don't need a plan)
├── project_id → projects.id
├── identifier          (human-readable, e.g., "TASK-42")
├── title
├── description
├── state               (todo, in_progress, done, cancelled)
├── priority            (integer)
├── labels              (text[])
├── source              (linear, github, api, manual)
├── source_id           (ID in the external system, if any)
├── source_url          (link back to Linear/GitHub/etc.)
├── metadata            (jsonb — source-specific fields)
├── assigned_to         (nullable — agent/worker assignment)
├── created_at
└── updated_at
```

When the orchestrator uses the `database` tracker adapter, it polls the `tasks` table
for rows matching `active_states` and maps them to `WorkItem` structs. State transitions
write back to the same table.

When using Linear or GitHub as a source, the API server syncs external items into the
`tasks` table. The orchestrator always reads from one place.

### Who writes what

```
                          users  projects  orchestrators  plans  tasks
                          ─────  ────────  ─────────────  ─────  ─────
Web Client (via API)        -      CRUD       read         CRUD   CRUD
API Server                 CRUD    CRUD       CRUD         CRUD   CRUD
Launcher                    -       -         status        -      -
Orchestrator + Agents       -       -          -            -     state, comments
External sync (webhooks)    -       -          -            -     create
```

**Agents are not a separate service.** They are Elixir Task processes spawned inside
the orchestrator. An "agent" = an Elixir Task + a Codex subprocess running in a workspace
directory. The orchestrator spawns them via `Task.Supervisor`, monitors them, and restarts
them on failure. Agent runtime state is ephemeral — held in the orchestrator's GenServer
state (`running` map), not persisted to any database. On orchestrator restart, state is
rebuilt from the tracker on the next poll cycle. Workspaces on disk survive restarts, so
agents resume rather than start from scratch.

When agents update task state or post comments, they do so through the orchestrator's
tracker adapter (e.g., `Tracker.update_issue_state/2`). From the database's perspective,
the orchestrator process is the only writer from this repo.

- **API server** (other repo) is the primary writer for `users`, `projects`, `orchestrators`,
  `plans`, and `tasks`.
- **Launcher** (this repo) only touches the `orchestrators` table to update `status` and `port`.
- **Orchestrator** (this repo) only touches the `tasks` table to update state
  (todo → in_progress → done) and add comments. It never creates tasks or plans.

## What this repo needs to build

### Launcher layer

1. **Launcher GenServer** — manages orchestrator lifecycle, port assignment, state persistence
2. **Launcher HTTP API** — Plug/Bandit server on `:4100` exposing the contract above
3. **Launcher supervision tree** — DynamicSupervisor for orchestrator processes
4. **Orchestrator startup via Launcher** — programmatic equivalent of the CLI's `evaluate/2`,
   accepting config as a map instead of CLI args
5. **State persistence** — write active orchestrator configs to disk so the Launcher can recover
   after restart

### Generic input layer

6. **`SymphonyElixir.WorkItem` struct** — rename from `Linear.Issue`, add `source` + `metadata`
7. **`Tracker.Linear` adapter** — move from `Linear.Adapter`, normalize to `WorkItem`
8. **`Tracker.Database` adapter** — poll Supabase/Postgres REST API for work items
9. **`Tracker.API` adapter** — GenServer-backed queue, accepts pushed items via HTTP
10. **`POST /api/v1/items` endpoint** — on orchestrator HTTP server, routes to `Tracker.API`
11. **Update tracker router** — add new adapter kinds to `Tracker.adapter/0`
12. **Update all `Linear.Issue` references** — orchestrator, agent runner, prompt builder,
    memory adapter, tests (8 files total)

The existing orchestrator dispatch loop, workspace management, and retry logic remain unchanged.
They operate on `WorkItem` the same way they operated on `Linear.Issue`.

### Runner abstraction layer

13. **`SymphonyElixir.Runner` behavior** — `start_session`, `run_turn`, `stop_session`, `ping`
14. **`Runner.Codex`** — extract existing `AppServer` logic behind the behavior
15. **`Runner.OpenClaw`** — HTTP adapter for OpenClaw API (`/v1/runs`)
16. **`Runner.ComputerUse`** — HTTP/WebSocket adapter for computer use agent API
17. **`Runner.Mock`** — test adapter with preconfigured responses
18. **Runner routing in `AgentRunner`** — resolve runner from work item labels / workflow config
19. **Runner config in schema** — add `runners` section to WORKFLOW.md / Launcher API config

## What the other repo needs to build

1. **Launcher client** — HTTP client that calls `LAUNCHER_BASE_URL` endpoints
2. **Orchestrator proxy** — route `/api/agents/*` to the correct orchestrator port via user lookup
3. **Setup flow** — collect repo URL, tracker config (Linear / database / API), workflow template;
   persist to Supabase; call Launcher
4. **Lifecycle management** — stop/restart orchestrators on config change, health-check polling
5. **WebSocket pass-through** — proxy WS connections to the orchestrator's WS endpoint
6. **Work item normalization** — if accepting GitHub webhooks or other external sources, normalize
   them into the `work_items` table that the database adapter reads
7. **Plans and tasks data model** — Supabase tables for plans (groups of tasks) and tasks
   (individual work items), with a view or query that the database adapter polls
