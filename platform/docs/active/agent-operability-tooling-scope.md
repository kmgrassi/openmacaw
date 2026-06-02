# Agent Operability Tooling Scope

## Goal

Make the app easier for coding agents to run, inspect, and debug locally from
both the CLI and browser.

Today, a capable agent can start the stack and follow
[End-to-End Local Runbook](../reference/end-to-end-local-runbook.md), but it
still has to infer too much from scattered logs, browser state, environment
files, and ad hoc `curl` commands. The goal of this scope is to add small,
repo-local tools that turn app state into explicit diagnostics an agent can
consume before deciding what to do next.

Good outcomes:

- An agent can tell whether the platform is running without reading long logs.
- An agent can identify the failing layer: env, API, web, Supabase, launcher,
  orchestrator, runtime relay, websocket, auth, or agent config.
- An agent can produce a compact support bundle for humans or other agents.
- Browser-visible failures have corresponding CLI probes and log breadcrumbs.
- Tools use the repo's canonical camelCase API contracts and snake_case DB
  conventions rather than adding compatibility shims.

## Existing Baseline

- `pnpm run dev` starts API and web and writes `.run-logs/api.log` and
  `.run-logs/web.log`.
- `pnpm run logs` dumps both logs, but does not filter, summarize, or classify.
- `/livez`, `/health`, `/api/agents/:agentId/health`, and
  `/api/diagnostic/agents/:agentId?workspaceId=...` already expose useful
  readiness and agent diagnostic data.
- `pnpm run db:schema:check` emits structured schema diagnostics.
- The web Settings area includes runtime and gateway diagnostic surfaces.
- [End-to-End Logging Improvement PR Plan](end-to-end-logging-pr-plan.md)
  covers structured log quality across service boundaries.

This document focuses on agent-facing tooling that consumes and presents that
state. It should complement, not replace, the logging plan.

## Proposed Work

### 1. `pnpm run doctor`: single-command local readiness report

Add a repo-root doctor command that checks the local stack and prints a
deterministic summary.

Suggested checks:

- Required env files exist in the places processes actually read:
  `apps/api/.env`, `apps/web/.env.local` or `apps/web/.env`.
- Required API env keys are present, with secret values redacted.
- Expected ports are reachable: API `3100`, web `5173`, launcher `4100`,
  orchestrator `4000`.
- `/livez`, `/health`, and `/api/v1/health` respond where applicable.
- `.run-logs` exists and has recent writes from API and web.
- `pnpm` dependencies are installed and workspace packages resolve.

Output shape:

```text
platform doctor: fail

ok    api env       apps/api/.env contains SUPABASE_URL, SUPABASE_PROJECT_ID, SUPABASE_SERVICE_ROLE_KEY
ok    web env       dev login variables available
ok    api           http://127.0.0.1:3100/livez returned 200
fail  launcher      http://127.0.0.1:4100/health connection refused
skip  agent         pass --agent-id and --workspace-id for scoped diagnostics

next: start parallel-agent-runtime, then rerun pnpm run doctor
```

Acceptance:

- Exits `0` only when required checks pass.
- Exits non-zero with actionable `next:` guidance on failure.
- Supports `--json` for agents that want machine-readable output.
- Never prints secrets.

### 2. `pnpm run doctor -- --agent-id ... --workspace-id ...`: scoped agent readiness

Extend the doctor command to call agent-scoped endpoints when an agent and
workspace are known.

Suggested checks:

- `GET /api/diagnostic/agents/:agentId?workspaceId=...`
- `GET /api/agents/:agentId/health`
- `GET /health?agentId=:agentId`
- Runtime target resolution and latest summarized failure when available.
- Credential, execution profile, runner kind, and local helper readiness from
  existing diagnostic payloads.

Acceptance:

- Summarizes `canChat`, `blockers`, runner kind, provider, execution target,
  launcher health, runtime health, and last failure.
- Keeps raw diagnostic JSON available behind `--json` or `--verbose`.
- Uses camelCase query params and response fields at the API boundary.

### 3. Log summarizer for `.run-logs`

Add a local log reader that turns API and web logs into a short recent-failure
view.

Suggested command:

```bash
pnpm run logs:summary -- --since 10m --agent-id <agent-id>
```

Suggested behavior:

- Parse JSON API logs when possible.
- Include non-JSON web/Vite log lines as plain text records.
- Group by `trace_id`, `request_id`, `agent_id`, `workspace_id`, route, event,
  error code, and layer.
- Highlight the last request failure, Supabase failure, launcher failure,
  websocket close, and browser build/runtime error.
- Provide a `--follow` mode for long-running agent sessions.

Acceptance:

- The default output is under roughly 80 lines.
- `--json` emits grouped records for automated consumption.
- Missing or malformed logs produce a clear warning, not a crash.

### 4. Browser smoke runner for the dev UI

Add a Playwright-based smoke script for the browser steps that are currently
manual in the runbook.

Suggested command:

```bash
pnpm run smoke:web
```

Suggested flow:

- Open `http://127.0.0.1:5173`.
- If `/login` appears, click **Use dev credentials**.
- Wait for `/api/auth/state`.
- Capture the resolved agent and workspace if available.
- Navigate to dashboard and Settings diagnostics.
- Fail on uncaught browser console errors, repeated auth redirects, or visible
  error boundaries.
- Save screenshots and console/network summaries under `.run-artifacts/`.

Acceptance:

- Can run headlessly from an agent CLI.
- Prints the route, auth state, selected agent/workspace, and first visible
  blocker.
- Does not hardcode credentials; it relies on the existing dev credentials
  button and env variables.

### 5. Dev diagnostics panel export

Add a browser-visible export action on existing diagnostics surfaces so an
agent or human can copy the current runtime/gateway state without inspecting
React internals.

Potential locations:

- Settings -> Runtime diagnostics
- Settings -> Agents -> Diagnostics
- Gateway debug panel

Export contents:

- Current URL and selected workspace/agent ids.
- Auth state summary, not tokens.
- Gateway connection state and last close reason.
- Agent health and diagnostic blockers.
- Browser console errors captured by the app, if a client-side capture hook is
  added.

Acceptance:

- Export is JSON and uses existing contract field names.
- Secrets and auth tokens are omitted.
- The same shape can be consumed by `pnpm run doctor -- --from-file`.

### 6. Support bundle generator

Add a command that collects the minimum useful local debugging evidence into a
single directory or zip.

Suggested command:

```bash
pnpm run support:bundle -- --agent-id <agent-id> --workspace-id <workspace-id>
```

Suggested contents:

- Doctor output.
- Agent diagnostic JSON.
- Recent log summary plus redacted raw excerpts.
- Schema diagnostic summary from `pnpm run db:schema:check`.
- Web smoke artifacts when `--include-browser` is passed.
- Git branch, commit, changed files, and package manager version.

Acceptance:

- Bundle is written to `.run-artifacts/support/<timestamp>/`.
- Redaction is applied before writing artifacts.
- The command prints a manifest of included and skipped files.

### 7. Environment diff and worktree readiness helper

Add a helper for worktree-specific setup drift, since agents frequently run
inside disposable worktrees.

Suggested command:

```bash
pnpm run env:doctor
```

Suggested checks:

- Compare expected env keys from examples against actual local env files.
- Detect when repo-root `.env` exists but `apps/api/.env` is missing.
- Detect when `apps/web/.env.example` has dev login variables that are absent
  from the active web env file.
- Report which env files each process reads.
- Offer copy commands as text, but do not copy secrets automatically.

Acceptance:

- Does not print secret values.
- Does not mutate env files unless a future explicit `--write` mode is added.
- Points to the runbook section that explains process-specific env loading.

### 8. Agent task probe library

Create a small reusable script module that other scripts and agents can import
instead of reimplementing local probes.

Potential module:

```text
scripts/lib/platform-probes.mjs
```

Suggested helpers:

- `probeHttpJson(url, options)`
- `probePort(host, port)`
- `loadRedactedEnv(filePath)`
- `readRecentLogLines(filePath, since)`
- `classifyPlatformFailure(result)`
- `printCheckTable(checks)`

Acceptance:

- New doctor, smoke, and support commands share this module.
- Tests cover classification for common failure modes.
- Helpers return structured data and leave formatting to callers.

## Suggested PR Sequence

### PR1: CLI doctor foundation

Add `scripts/doctor.mjs`, `pnpm run doctor`, shared probe helpers, and basic
process/env/port checks.

This gives agents an immediate starting point and creates the helper library
for later scripts.

### PR2: Scoped agent diagnostics in doctor

Teach doctor to consume existing agent health and diagnostic endpoints when
`--agent-id` and `--workspace-id` are provided.

This should not add new API shapes unless existing diagnostics are missing a
critical field.

### PR3: Log summary command

Add `scripts/log-summary.mjs` and `pnpm run logs:summary`.

Keep this independent from the broader structured logging plan by parsing the
logs that exist today, while benefiting from new structured fields as they land.

### PR4: Browser smoke runner and artifacts

Add a Playwright smoke script, screenshots, console capture, and a concise CLI
summary.

This PR should follow the UI testing requirements in `AGENTS.md` and verify the
real browser flow.

### PR5: Diagnostics export and support bundle

Add a diagnostics JSON export in the web UI and a support bundle command that
combines doctor, diagnostics, logs, schema checks, and optional browser smoke
artifacts.

## Non-Goals

- Do not add old-format compatibility handling for API payloads.
- Do not create new Supabase migrations in this repo.
- Do not manually edit generated Supabase types.
- Do not replace production observability work with local-only scripts.
- Do not make scripts depend on hardcoded credentials or a specific developer's
  local paths.
- Do not make the Go local-runtime-helper expose a legacy HTTP daemon for
  platform convenience.

## Open Questions

- Should `doctor` live as plain Node scripts or as a small TypeScript package
  built with the repo toolchain?
- Should browser smoke artifacts be kept under `.run-artifacts/`, `.run-logs/`,
  or a new ignored directory?
- Which diagnostic fields should become contract-level guarantees versus
  best-effort local output?
- Should support bundles include redacted raw logs by default, or only summaries
  unless `--include-raw` is passed?
