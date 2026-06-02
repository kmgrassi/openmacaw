# Agent Runtime Ergonomics Scope

## Goal

Make this app easier for coding agents, manager agents, and browser-driven
agents to understand, start, test, and debug without requiring a human to
manually inspect several terminals, raw logs, browser tabs, and related repos.

This scope focuses on small tooling and observability improvements around the
existing local runtime flow:

- `pnpm run start:local`
- `pnpm run smoke:runtime`
- `pnpm run smoke:manager`
- `pnpm run debug:orchestrator:ws`
- launcher health on `:4100`
- orchestrator health and state on `:4000`
- platform API and web UI in `parallel-agent-platform`

The target user is an agent operating from the CLI or browser. The agent should
be able to answer, quickly and mechanically:

- What is running?
- What is unhealthy?
- What command should I run next?
- Which log lines explain the current failure?
- Is the browser gateway path connected to the same runtime I am inspecting?
- Did the manager/planner actually create or process the expected work item?

## Principles

- **Machine-readable first:** every helper should support JSON output, even if it
  also prints a human summary.
- **No secret leakage:** helpers should redact environment values, bearer tokens,
  service-role keys, prompt bodies, and raw tool payloads by default.
- **One command for orientation:** agents should not need to remember a sequence
  of `curl`, `lsof`, `tail`, and `pnpm` commands just to learn the current state.
- **Reuse existing scripts:** extend `scripts/runtime-smoke.mjs`,
  `scripts/manager-smoke.mjs`, `scripts/runtime-ws-client.mjs`, and
  `scripts/start-local-runtime.sh` where practical.
- **Actionable failures:** every failed check should include the likely cause,
  the evidence, and one next command.

## Proposed Improvements

### 1. `runtime doctor` CLI

Add a single diagnostic command that gathers the local runtime state and returns
both a concise terminal summary and structured JSON.

Suggested command:

```bash
pnpm run doctor:runtime
pnpm run doctor:runtime -- --json
```

Checks:

- required CLIs: `mise`, `pnpm`, `node`, `mix`, `curl`, `lsof`
- launcher health at `http://127.0.0.1:4100/health`
- orchestrator health at `http://127.0.0.1:4000/api/v1/health`
- port ownership for `4000`, `4100`, optionally `3100`, `5173`, `11434`
- recent `.run-logs/launcher.log` and `.run-logs/orchestrator.log` freshness
- database connectivity from launcher health
- expected `.env` presence without printing values

Example JSON shape:

```json
{
  "ok": false,
  "services": {
    "launcher": { "status": "healthy", "url": "http://127.0.0.1:4100/health" },
    "orchestrator": { "status": "unreachable", "url": "http://127.0.0.1:4000/api/v1/health" }
  },
  "next_steps": [
    "pnpm run start:local",
    "tail -n 120 .run-logs/orchestrator.log"
  ]
}
```

Success criteria:

- An agent can run one command and determine whether to start services, inspect
  logs, fix env, or continue to browser/gateway testing.
- The helper exits non-zero when required runtime pieces are unhealthy.

### 2. Guided Local Stack Launcher

Extend `scripts/start-local-runtime.sh` or add a wrapper that can start the
runtime and then emit a ready-to-use agent context block.

Suggested command:

```bash
pnpm run start:local:agent
```

Output should include:

- launcher URL
- orchestrator URL
- log file paths
- exact smoke commands
- current process ids
- whether existing listeners were reused
- a stable run id for correlating logs emitted during this local session

This can be implemented as a thin wrapper around `start:local` once the runtime
doctor exists, or by adding an `AGENT_SUMMARY=1` mode to the existing script.

Success criteria:

- The command prints a copyable, complete operating context for a subsequent
  agent turn.
- The summary is deterministic enough that another agent can parse it.

### 3. Unified Log Tail and Filter Helper

Add a log helper for `.run-logs` that can show recent launcher and orchestrator
events with common filters.

Suggested commands:

```bash
pnpm run logs:runtime
pnpm run logs:runtime -- --since 10m --level error
pnpm run logs:runtime -- --trace-id <trace-id>
pnpm run logs:runtime -- --service orchestrator --json
```

Initial implementation can parse plain text logs and classify lines with simple
rules. Later it can consume structured logs when those are added.

Useful filters:

- service: `launcher`, `orchestrator`
- level: `error`, `warn`, `info`
- text search
- trace id / run id / session key when present
- last N lines
- since duration based on file mtime or line timestamps when available

Success criteria:

- Agents no longer need to manually tail multiple files.
- Failed smoke tests can point to a single log command that surfaces the likely
  failure lines.

### 4. Runtime Snapshot Endpoint and CLI

Add an agent-facing snapshot endpoint, or a CLI that aggregates existing
endpoints, to summarize runtime state in one object.

Suggested endpoint:

```text
GET /api/v1/agent-snapshot
```

Suggested CLI:

```bash
pnpm run snapshot:runtime
pnpm run snapshot:runtime -- --json
```

Snapshot contents:

- launcher health and DB status
- orchestrator health
- active sessions/runs if available
- manager status when `workspace_id` is provided
- configured execution profiles without secrets
- recent failures by category
- links/commands for deeper inspection

This can start as a Node script that calls existing HTTP endpoints. A native
runtime endpoint can follow once the shape proves useful.

Success criteria:

- A manager agent can inspect the runtime without scraping raw logs.
- The snapshot payload is stable enough to be used in automated smoke tests.

### 5. Browser Gateway Smoke Script

Create a smoke test that validates the browser-facing gateway path from the
same inputs an agent uses in the UI.

Suggested commands:

```bash
pnpm run smoke:gateway
pnpm run smoke:gateway -- --agent-id <agent-id> --workspace-id <workspace-id>
pnpm run smoke:gateway -- --message "health check" --json
```

This should build on `scripts/runtime-ws-client.mjs`, but produce a higher-level
pass/fail result:

- WebSocket can connect.
- `hello-ok` is received.
- `sessions.list`, `models.list`, and `config.get` return successfully.
- Optional `chat.send` receives a final, error, or timeout state.
- Output includes `session_key`, request ids, and run id when present.

Success criteria:

- An agent can verify whether a browser chat failure is in the platform/browser
  path or in the runtime/model path.
- The script emits enough ids to search logs for the same interaction.

### 6. Local Browser State Probe

Add a small browser-accessible diagnostics page or JSON endpoint that presents
runtime connectivity in the same form the platform UI needs.

Potential surfaces:

- launcher page at `http://127.0.0.1:4100/debug/local`
- orchestrator page at `http://127.0.0.1:4000/debug/local`
- JSON-only endpoint if adding HTML is too much surface area

The page should show:

- service health
- current configured ports
- WebSocket URL template
- last known manager tick for a workspace if provided
- recent error summaries
- links to health endpoints

This is not intended to replace platform diagnostics. It gives a browser agent
a direct runtime view when the platform is down or not yet started.

Success criteria:

- A browser-driving agent can open one URL and inspect whether the runtime is
  available before interacting with the full platform UI.
- The page does not expose secrets or raw prompts.

### 7. Work Item Verification Helper

Add a CLI helper for validating planner-created work items through Supabase REST
without requiring the agent to hand-write `curl` commands.

Suggested commands:

```bash
pnpm run verify:work-item -- --title "Verify direct work item creation"
pnpm run verify:work-item -- --id <work-item-id> --json
pnpm run verify:work-item -- --task-id <assistant-task-id>
```

Checks:

- loads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from local env
- queries `work_items` by title or id
- optionally verifies no legacy `task` row exists for direct planner task
  creation
- redacts keys in all output
- prints expected vs actual values for `source`, `state`, `metadata`, `plan_id`

Success criteria:

- The browser login and planner work item smoke can be run by an agent without
  copying service-role-key `curl` snippets into the terminal.
- Failure output states whether the issue is missing env, auth, no row,
  duplicate rows, or an unexpected row shape.

### 8. Agent Context Bundle

Create a command that writes a redacted local context bundle for handoff between
agents or for attaching to PRs.

Suggested command:

```bash
pnpm run agent:context
pnpm run agent:context -- --output .run-logs/agent-context.json
```

Bundle contents:

- git branch and short status
- package scripts
- runtime doctor result
- smoke results
- recent redacted log summaries
- relevant local URLs
- versions for Node, pnpm, Elixir, Erlang, and mix
- selected environment variable names that are present, not values

Success criteria:

- A new agent can load one artifact and avoid rediscovering the same local
  runtime state.
- The bundle is safe to paste into issue comments or PR descriptions after
  redaction review.

### 9. Failure Catalog and Next-Step Hints

Add a small failure catalog used by smoke and doctor scripts to convert common
errors into actionable next steps.

Examples:

| Symptom | Likely Cause | Suggested Next Step |
| --- | --- | --- |
| `ECONNREFUSED :4000` | Orchestrator is not running | `pnpm run start:local` |
| launcher `database.connected=false` | Supabase env or network issue | Check `.env`, then run `pnpm run smoke:runtime` |
| stale manager `last_tick_at` | Manager scheduler not running or blocked | `pnpm run smoke:manager -- --workspace-id <id>` |
| WebSocket closes before `hello-ok` | Gateway auth/session/config mismatch | Run `pnpm run smoke:gateway -- --json` |
| port in use by unrelated process | Local service collision | Inspect `lsof -nP -iTCP:<port> -sTCP:LISTEN` |

Implementation options:

- shared JSON file under `scripts/diagnostics/failure-catalog.json`
- small JavaScript module imported by doctor/smoke/log scripts
- plain markdown catalog first, code integration later

Success criteria:

- Tool failures tell agents what to do next instead of stopping at raw stack
  traces.
- New failure modes can be documented once and reused across scripts.

## Suggested PR Sequence

### PR1: Runtime Doctor and Failure Catalog

- Add `scripts/runtime-doctor.mjs`.
- Add `pnpm run doctor:runtime`.
- Add a minimal failure catalog.
- Keep this read-only and local-only.

### PR2: Log Helper

- Add `scripts/runtime-logs.mjs`.
- Add `pnpm run logs:runtime`.
- Support service, level, text, and JSON output.
- Teach `doctor:runtime` to recommend filtered log commands.

### PR3: Agent Stack Summary

- Add `pnpm run start:local:agent` or `AGENT_SUMMARY=1` support.
- Include process ids, URLs, smoke commands, and log paths.
- Optionally write `.run-logs/current-runtime.json`.

### PR4: Gateway Smoke

- Wrap or extend `scripts/runtime-ws-client.mjs`.
- Add `pnpm run smoke:gateway`.
- Emit request ids, run ids, session key, and JSON result.

### PR5: Snapshot and Work Item Verification

- Add `pnpm run snapshot:runtime`.
- Add `pnpm run verify:work-item`.
- Keep DB queries redacted and read-only.

### PR6: Browser Diagnostics Page

- Add a small runtime debug endpoint/page after CLI shapes settle.
- Include links to health endpoints and JSON snapshot output.
- Avoid exposing secrets, raw prompt content, or write actions.

## Open Questions

- Should the canonical agent snapshot live in the launcher, orchestrator, or a
  root-level CLI that aggregates both?
- Should diagnostic JSON schemas be versioned so platform agents can depend on
  them?
- Should log helpers parse existing text logs only, or should this work wait for
  structured logging improvements?
- How much browser smoke should live in this repo versus
  `parallel-agent-platform`?
- Should local context bundles be ignored by git under `.run-logs`, or should a
  sanitized version be allowed under `docs/debug-artifacts` for PR evidence?

## Non-Goals

- Replacing production observability or CloudWatch.
- Adding compatibility shims for old execution profile values or API shapes.
- Writing secrets, prompts, or full tool payloads into diagnostic artifacts.
- Building autonomous self-healing before basic diagnosis is reliable.
- Moving database migrations into this repo.

## Validation

Before committing changes in this repo, run the standard orchestrator gate:

```bash
cd apps/orchestrator
mix compile --warnings-as-errors
mix test
```

For implementation PRs that touch local runtime behavior, also run the relevant
runtime smoke checks:

```bash
pnpm run smoke:runtime
pnpm run smoke:manager -- --workspace-id <workspace-id>
```
