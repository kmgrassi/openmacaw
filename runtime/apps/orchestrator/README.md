# OpenMacaw Orchestrator (Symphony Elixir)

This directory contains the Elixir/OTP orchestrator that powers the OpenMacaw
runtime. The codebase is derived from OpenAI's
[Symphony](https://github.com/openai/symphony) prototype, and the module
namespace (`SymphonyElixir`) still reflects that origin.

> [!NOTE]
> For local development, the orchestrator is normally started as part of the
> full stack with `./openmacaw run` from the repository root, or with
> `pnpm run start:local` from `runtime/`. The instructions below cover
> running the orchestrator on its own in its original standalone
> (Linear + Codex) mode.

## How it works

1. Polls Linear for candidate work
2. Creates a workspace per issue
3. Launches Codex in [App Server mode](https://developers.openai.com/codex/app-server/) inside the
   workspace
4. Sends a workflow prompt to Codex
5. Keeps Codex working on the issue until the work is done

During app-server sessions, Symphony also serves a client-side `linear_graphql` tool so that repo
skills can make raw Linear GraphQL calls.

If a claimed issue moves to a terminal state (`Done`, `Closed`, `Cancelled`, or `Duplicate`),
Symphony stops the active agent for that issue and cleans up matching workspaces.

The runtime also includes a launcher-hosted worker bridge for external callers.
When `mix launcher.start` is running, the launcher exposes `/worker-bridge/sessions`
on port `4100` so the platform server can spin up credential-scoped workers
without choosing the raw worker command itself.

## How to use it

1. Make sure your codebase is set up to work well with agents: see
   [Harness engineering](https://openai.com/index/harness-engineering/).
2. Get a new personal token in Linear via Settings → Security & access → Personal API keys, and
   set it as the `LINEAR_API_KEY` environment variable.
3. Copy this directory's `WORKFLOW.md` to your repo.
4. Optionally copy the `commit`, `push`, `pull`, `land`, and `linear` skills to your repo.
   - The `linear` skill expects Symphony's `linear_graphql` app-server tool for raw Linear GraphQL
     operations such as comment editing or upload flows.
5. Customize the copied `WORKFLOW.md` file for your project.
   - To get your project's slug, right-click the project and copy its URL. The slug is part of the
     URL.
   - When creating a workflow based on this repo, note that it depends on non-standard Linear
     issue statuses: "Rework", "Human Review", and "Merging". You can customize them in
     Team Settings → Workflow in Linear.
6. Follow the instructions below to install the required runtime dependencies and start the service.

## Prerequisites

We recommend using [mise](https://mise.jdx.dev/) to manage Elixir/Erlang versions.

```bash
mise install
mise exec -- elixir --version
```

## Run

From this directory (`runtime/apps/orchestrator/`):

```bash
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
mise exec -- ./bin/symphony ./WORKFLOW.md
```

## Configuration

Pass a custom workflow file path to `./bin/symphony` when starting the service:

```bash
./bin/symphony /path/to/custom/WORKFLOW.md
```

If no path is passed, Symphony defaults to `./WORKFLOW.md`.

Optional flags:

- `--logs-root` tells Symphony to write logs under a different directory (default: `./log`)
- `--port` also starts the Phoenix observability service (default: disabled)

The `WORKFLOW.md` file uses YAML front matter for configuration, plus a Markdown body used as the
Codex session prompt.

Minimal example:

```md
---
tracker:
  kind: linear
  project_slug: "..."
workspace:
  session_workspace_root: ~/code/workspaces
  repo_cache_root: ~/code/repo-cache
  artifact_sink: ./artifacts
hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: codex app-server
---

You are working on a Linear issue {{ issue.identifier }}.

Title: {{ issue.title }} Body: {{ issue.description }}
```

Notes:

- If a value is missing, defaults are used.
- Safer Codex defaults are used when policy fields are omitted:
  - `codex.approval_policy` defaults to `{"reject":{"sandbox_approval":true,"rules":true,"mcp_elicitations":true}}`
  - `codex.thread_sandbox` defaults to `workspace-write`
  - `codex.turn_sandbox_policy` defaults to a `workspaceWrite` policy rooted at the current issue workspace
- Supported `codex.approval_policy` values depend on the targeted Codex app-server version. In the current local Codex schema, string values include `untrusted`, `on-failure`, `on-request`, and `never`, and object-form `reject` is also supported.
- Supported `codex.thread_sandbox` values: `read-only`, `workspace-write`, `danger-full-access`.
- When `codex.turn_sandbox_policy` is set explicitly, Symphony passes the map through to Codex
  unchanged. Compatibility then depends on the targeted Codex app-server version rather than local
  Symphony validation.
- `agent.max_turns` caps how many back-to-back Codex turns Symphony will run in a single agent
  invocation when a turn completes normally but the issue is still in an active state. Default: `20`.
- `execution_profile` is optional resolved routing metadata supplied by the platform. When present,
  it must include `runner_kind` and `provider`; Symphony logs only runner/provider/model/source
  metadata and redacts secret-shaped fields. When absent, the runtime derives a legacy Codex
  fallback from existing `codex`, `runners`, and stored-agent model settings.
- If the Markdown body is blank, Symphony uses a default prompt template that includes the issue
  identifier, title, and body.
- Use `hooks.after_create` to bootstrap a fresh workspace. For a Git-backed repo, you can run
  `git clone ... .` there, along with any other setup commands you need.
- If a hook needs `mise exec` inside a freshly cloned workspace, trust the repo config and fetch
  the project dependencies in `hooks.after_create` before invoking `mise` later from other hooks.
- `tracker.api_key` reads from `LINEAR_API_KEY` when unset or when value is `$LINEAR_API_KEY`.
- For database-backed work, set `tracker.kind: database` and point `tracker.table` at
  `work_items`. Optional `tracker.workspace_id`, `tracker.plan_id`, and `tracker.runner_type`
  filters scope what this runtime polls.
- For path values, `~` is expanded to the home directory.
- `workspace.root` remains a compatibility alias for the session workspace root.
- `workspace.session_workspace_root` is the explicit root for mutable agent workspaces.
- `workspace.repo_cache_root` is the explicit root for durable repository cache data.
- `workspace.artifact_sink` is the explicit destination for durable artifacts; it may be a local
  path or a URI such as `s3://bucket/prefix`.
- For env-backed path values, use `$VAR`. `workspace.root`, `workspace.session_workspace_root`, and
  `workspace.repo_cache_root` resolve `$VAR` before path handling. `workspace.artifact_sink`
  resolves `$VAR` and preserves URI values. `codex.command` stays a shell command string and any
  `$VAR` expansion there happens in the launched shell.

```yaml
tracker:
  api_key: $LINEAR_API_KEY
workspace:
  session_workspace_root: $SYMPHONY_SESSION_WORKSPACE_ROOT
  repo_cache_root: $SYMPHONY_REPO_CACHE_ROOT
  artifact_sink: $SYMPHONY_ARTIFACT_SINK
hooks:
  after_create: |
    git clone --depth 1 "$SOURCE_REPO_URL" .
codex:
  command: "$CODEX_BIN app-server --model gpt-5.3-codex"
```

### Database work item shape

The database tracker reads normalized rows from `work_items`. The platform keeps `task` as the
canonical row and projects it into `work_items`; the runtime reads the projection and writes
state updates back to `task` through `work_items.task_id`.

Routing only requires a normalized work item with an `id`, `identifier`, `title`, active `state`,
and enough scope to match the runtime's tracker filters. The content does not need to follow a
special Markdown template to dispatch. It should still include enough detail for Codex to complete
the work because the prompt template receives the work item fields as `{{ issue.* }}`.

A useful database-created coding task should look like this at the canonical `task` layer:

```json
{
  "workspace_id": "<workspace uuid>",
  "plan_id": "<plan uuid>",
  "name": "Implement scoped database tracker polling",
  "description": "Context, exact requirements, acceptance criteria, and validation steps.",
  "state": "todo",
  "status": "todo",
  "priority": "medium",
  "source": "api",
  "external_id": "plan:<plan-id>:task:<stable-id>",
  "labels": ["runner:codex"],
  "metadata": {
    "runner_type": "codex",
    "url": "https://...",
    "repo": "kmgrassi/parallel-agent-runtime",
    "branch_name": "codex/db-scoped-codex"
  }
}
```

`labels: ["runner:codex"]` routes the item to Codex. `metadata.runner_type: "codex"` also routes
to Codex when no `runner:*` label is present. Labels intentionally have higher priority so a
single task can override the plan/runtime default.

The prompt quality bar is separate from routing. For unattended coding work, put the concrete
requirements, constraints, expected PR behavior, and test plan in `description`. If the current
workflow body still references Linear-specific actions, use a database-specific workflow template
for database-tracker agents.

Today these rows are created by the platform API:

- `POST /api/work-items` for manual/API-created tasks
- `POST /api/webhooks/github` for GitHub issue/PR webhook ingestion
- `POST /api/webhooks/linear` for Linear issue webhook ingestion
- `apps/api/scripts/backfill-linear-projects.ts` for Linear project backfills

The planned runtime-side planner tools (`plan.create`, `task.create`, `task.update`, `plan.read`,
and `task.read`) are scoped in `docs/planning-agent-scope.md`; they are not the current creation
path yet.

### Database migrations

All database migrations live in the `harper-server` repository. Do not add
Supabase migration files to this repository, and do not run forced database
migrations from the runtime or platform repos.

To make a database change, create the migration file in `harper-server`, send
it through normal code review, and merge it there. The migration is applied by
the `harper-server` CI/deploy pipeline as it is promoted to production.

After a `harper-server` migration changes schema consumed by the runtime, run
the repo-level schema sync documented in `../../AGENTS.md` so the generated
PostgREST metadata and TypeScript types in this repository stay current.

- If `WORKFLOW.md` is missing or has invalid YAML at startup, Symphony does not boot.
- If a later reload fails, Symphony keeps running with the last known good workflow and logs the
  reload error until the file is fixed.
- `server.port` or CLI `--port` enables the optional Phoenix LiveView dashboard and JSON API at
  `/`, `/api/v1/health`, `/api/v1/state`, `/api/v1/<issue_identifier>`, and `/api/v1/refresh`.

## Launcher and worker bridge

The runtime exposes a separate launcher service for orchestration lifecycle and
worker-bridge APIs:

```bash
mix launcher.start
```

Defaults:

- launcher health: `http://127.0.0.1:4100/health`
- worker bridge: `http://127.0.0.1:4100/worker-bridge/sessions`
- bind host: `127.0.0.1` (`LAUNCHER_BIND_HOST=0.0.0.0` only behind a private listener)

For platform-driven worker launches, the expected request body is:

```json
{
  "kind": "codex",
  "cwd": "/tmp/symphony-workspaces/ISSUE-123",
  "credentials": {
    "OPENAI_API_KEY": {
      "source": "inline",
      "value": "sk-..."
    }
  }
}
```

The launcher resolves `"kind": "codex"` to the configured `codex.command` from
`WORKFLOW.md`, injects credential environment variables, and spawns the worker
under the requested `cwd`.

See [docs/worker-bridge.md](docs/worker-bridge.md) for the full request flow and API contract.

## Web dashboard

The observability UI now runs on a minimal Phoenix stack:

- LiveView for the dashboard at `/`
- JSON API for operational debugging under `/api/v1/*`
- Local runtime helper relay WebSocket at `/local-relay/ws`; see
  [docs/local-relay-protocol.md](docs/local-relay-protocol.md)
- Bandit as the HTTP server
- Phoenix dependency static assets for the LiveView client bootstrap

## Project Layout

- `lib/`: application code and Mix tasks
- `test/`: ExUnit coverage for runtime behavior
- `WORKFLOW.md`: in-repo workflow contract used by local runs
- `../.codex/`: repository-local Codex skills and setup helpers

## Testing

```bash
make all
```

Run the real external end-to-end test only when you want Symphony to create disposable Linear
resources and launch a real `codex app-server` session:

```bash
cd elixir
export LINEAR_API_KEY=...
make e2e
```

Optional environment variables:

- `SYMPHONY_LIVE_LINEAR_TEAM_KEY` defaults to `SYME2E`
- `SYMPHONY_LIVE_SSH_WORKER_HOSTS` uses those SSH hosts when set, as a comma-separated list

`make e2e` runs two live scenarios:
- one with a local worker
- one with SSH workers

If `SYMPHONY_LIVE_SSH_WORKER_HOSTS` is unset, the SSH scenario uses `docker compose` to start two
disposable SSH workers on `localhost:<port>`. The live test generates a temporary SSH keypair,
mounts the host `~/.codex/auth.json` into each worker, verifies that Symphony can talk to them
over real SSH, then runs the same orchestration flow against those worker addresses. This keeps
the transport representative without depending on long-lived external machines.

Set `SYMPHONY_LIVE_SSH_WORKER_HOSTS` if you want `make e2e` to target real SSH hosts instead.

The live test creates a temporary Linear project and issue, writes a temporary `WORKFLOW.md`, runs
a real agent turn, verifies the workspace side effect, requires Codex to comment on and close the
Linear issue, then marks the project completed so the run remains visible in Linear.

## FAQ

### Why Elixir?

Elixir is built on Erlang/BEAM/OTP, which is great for supervising long-running processes. It has an
active ecosystem of tools and libraries. It also supports hot code reloading without stopping
actively running subagents, which is very useful during development.

### What's the easiest way to set this up for my own codebase?

Launch `codex` in your repo, give it the URL to the Symphony repo, and ask it to set things up for
you.

## License

This project is licensed under the [Apache License 2.0](../LICENSE).
