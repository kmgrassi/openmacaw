# End-to-End Local Runbook

## 5 Minute Quickstart

Use this when you already know the setup and just need to prove the platform works.

1. Start `parallel-agent-runtime` so:
   - launcher responds on `http://127.0.0.1:4100`
   - orchestrator responds on `http://127.0.0.1:4000`
2. Put env in the files the dev processes actually read:
   - `apps/api/.env`
     - `SUPABASE_URL`
     - `SUPABASE_SERVICE_ROLE_KEY`
     - `SUPABASE_PROJECT_ID`
     - optional: `ORCHESTRATOR_BASE_URL`, `LAUNCHER_BASE_URL`, `CORS_ORIGINS`
   - `apps/web/.env.local`
     - optional: `VITE_DEV_LOGIN_EMAIL`, `VITE_DEV_LOGIN_PASSWORD`, `VITE_WORKER_BRIDGE_DEFAULT_CWD`
3. Start this repo from the root:

```bash
pnpm run dev
```

4. Verify process-level endpoints:

```bash
curl -i http://127.0.0.1:3100/livez
curl -i http://127.0.0.1:5173
```

5. Open `http://127.0.0.1:5173`, log in, and confirm:
   - `/api/auth/state` succeeds in the browser network tab
   - you can identify a `resolved_agent_id`
   - `GET /health?agentId=<resolved-agent-id>` returns healthy
   - `GET /api/agents/<resolved-agent-id>` returns the agent runtime payload
   - onboarding completes when required
   - the app reaches chat without a refresh loop
   - a test message sends and returns a streamed response or a deterministic provider/config error
   - Settings -> Runtime loads current runtime/session state

Treat the run as passing only if both the process-level checks and the browser flow checks succeed.

## What "end to end" means here

This document is for an agent or engineer who needs to prove that the local platform stack is actually working end to end.

It is not just a "how to boot the dev server" note. The goal is to verify:

- the external runtime dependencies are up,
- this repo starts cleanly,
- login works,
- onboarding works,
- the runtime can be prepared,
- chat and runtime UI behave as expected.

For this repo, "end to end" means all of these pieces are working together:

- `parallel-agent-runtime` launcher on `:4100`
- `parallel-agent-runtime` orchestrator runtime on `:4000`
- this repo's API gateway on `:3100`
- this repo's web client on `:5173`
- Supabase auth and database access

The browser should be able to:

1. sign in,
2. load auth state from the platform API,
3. prepare or reuse runtime state for an agent,
4. connect websocket traffic through `/ws`,
5. complete onboarding if required,
6. send a chat message and receive a streamed response or a deterministic provider/config error,
7. inspect runtime status in Settings.

## Repo boundaries

This repo does **not** own the full runtime system.

- This repo owns:
  - web client
  - API gateway / proxy
  - shared contracts
  - Supabase-backed platform metadata reads/writes
- The runtime repo owns:
  - launcher process management
  - orchestrator runtime
  - worker bridge lifecycle
  - runtime websocket implementation

The architecture reference is:

- [launcher-architecture-and-cross-repo-integration.md](./launcher-architecture-and-cross-repo-integration.md)

The cross-repo implementation plan is:

- [launcher-integration-pr-plan.md](./launcher-integration-pr-plan.md)

## Required local services

Before starting this repo, make sure these dependencies exist locally:

- launcher listening on `http://127.0.0.1:4100`
- orchestrator runtime listening on `http://127.0.0.1:4000`
- valid Supabase project access

This repo assumes these defaults unless you override them:

- `ORCHESTRATOR_BASE_URL=http://127.0.0.1:4000`
- `LAUNCHER_BASE_URL=http://127.0.0.1:4100`
- API on `http://127.0.0.1:3100`
- web on `http://127.0.0.1:5173`

## Required environment

`pnpm run dev` does not source a repo-root `.env`.

The API starts from `apps/api`, and the web app starts from `apps/web`, so put configuration where those processes actually read it:

- `apps/api/.env`
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_PROJECT_ID`
  - optional: `ORCHESTRATOR_BASE_URL`, `LAUNCHER_BASE_URL`, `CORS_ORIGINS`
- `apps/web/.env.local` or `apps/web/.env`
  - `VITE_DEV_LOGIN_EMAIL`
  - `VITE_DEV_LOGIN_PASSWORD`
  - `VITE_WORKER_BRIDGE_DEFAULT_CWD`

Notes:

- `scripts/dev.sh` injects `VITE_BROKER_BASE` and `VITE_GATEWAY_WS_URL` for local dev, so you do not need to set those manually for the standard local flow.
- `VITE_DEV_LOGIN_EMAIL` and `VITE_DEV_LOGIN_PASSWORD` enable dev auto-login in the web client.
- `VITE_WORKER_BRIDGE_DEFAULT_CWD` enables one-click worker startup from onboarding and settings.
- If `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are missing from `apps/api/.env`, auth-state, agent, and stored-credential routes will fail even if the API process boots.

## Startup order

Use this order when validating the full system:

1. Start the launcher and runtime from `parallel-agent-runtime`.
2. Verify launcher and runtime respond before starting this repo.
3. Start this repo's API and web.
4. Verify API liveness first.
5. Open the browser and run the auth, runtime, and UI checks.

## Step 1: verify runtime dependencies

From any shell:

```bash
curl -sS http://127.0.0.1:4100/agents
curl -sS http://127.0.0.1:4000/api/v1/health
```

Expected:

- launcher responds on `:4100`
- orchestrator responds on `:4000`

If these are down, this repo can still partially boot, but the run is **not** end to end.

## Step 2: start this repo

From the repo root:

```bash
pnpm run dev
```

That script starts:

- `apps/api` on `:3100`
- `apps/web` on `:5173`

It also enforces fixed ports and will stop older project-owned listeners if needed.

Useful log command:

```bash
pnpm run logs
```

## Step 3: verify process endpoints

Check the API first:

```bash
curl -i http://127.0.0.1:3100/livez
```

Expected:

- `/livez` returns `200`

Failure interpretation:

- `/livez` fails:
  - API is not running

Then verify the web server:

```bash
curl -i http://127.0.0.1:5173
```

Expected:

- `200` HTML response from Vite

## Step 4: verify auth and scoped runtime endpoints

After login, verify the real app-scoped API routes.

1. Confirm `/api/auth/state` succeeds in the browser network tab.
2. Capture the `resolved_agent_id` from that response.
3. Probe the scoped runtime endpoints:

```bash
curl -i "http://127.0.0.1:3100/health?agentId=<resolved-agent-id>"
curl -i "http://127.0.0.1:3100/api/agents/<resolved-agent-id>"
```

Expected:

- `/api/auth/state` succeeds after login
- `/health?agentId=...` returns `200` only when both launcher and that agent's orchestrator runtime are healthy
- `/api/agents/<resolved-agent-id>` returns the runtime-backed agent payload

Failure interpretation:

- `/api/auth/state` fails:
  - missing access token, bad Supabase config, or auth-state setup failure
- scoped `/health` returns `503` or `502`:
  - launcher may be healthy, but the resolved agent runtime is unreachable or unhealthy
- `/api/agents/<resolved-agent-id>` fails:
  - runtime target resolution failed for that agent, or the orchestrator route is unhealthy

## Step 5: browser validation checklist

Open:

- `http://127.0.0.1:5173`

Use this sequence.

### A. Login path

If dev auto-login is configured:

- the app should move past login automatically

If dev auto-login is not configured:

- sign in manually on `/login`
- if sign-up is being tested instead, verify Supabase behavior matches the environment:
  - immediate session if email confirmation is disabled
  - unauthenticated with confirmation message if email confirmation is enabled

Expected post-login behavior:

- app should not dead-end on a blank screen
- auth store should move to either:
  - `authenticated`
  - `needs_onboarding`

### B. Dashboard-first path

If a resolved agent already exists:

- the app may land directly on `/`
- chat layout should render
- no infinite reconnect loop
- no repeated auth/runtime polling caused by reconnect churn

Expected runtime indicators:

- settings/runtime shows current connection state
- `Gateway reachable` should reflect scoped runtime health for the resolved agent, not just bare `/health`
- websocket should connect through `/ws`

### C. Onboarding path

If no usable agent or no runtime-ready setup exists:

- app should route to `/onboarding`

Walk through the wizard:

1. Agent
2. Provider
3. Auth
4. Credentials
5. Model

Click `Save & Connect`.

Expected:

- completion card appears
- selected provider/model is shown
- if credentials were stored, the UI says so explicitly

If `VITE_WORKER_BRIDGE_DEFAULT_CWD` is set and provider is OpenAI:

- `Validate & Start Worker` should be available
- clicking it should either:
  - validate and start a worker session, or
  - show a deterministic validation error

Then click `Continue to App`.

Expected:

- app returns to `/`
- auth store re-orchestrates
- dashboard becomes usable without a page refresh

### D. Provider-error path

This is an important local test.

If credentials or model configuration are intentionally incomplete:

- initial app load should still connect if runtime scope is valid
- first message send should fail deterministically
- error should be visible in chat
- the socket should stay alive
- CTA should point back to `/onboarding`

Reference behavior:

- [apps/web/docs/model-agnostic-startup-notes.md](../../apps/web/docs/model-agnostic-startup-notes.md)

### E. Chat path

Once onboarding or existing setup is valid:

1. open an agent
2. confirm a session is selected
3. send a test message

Expected:

- composer is enabled
- no transport error on send
- streaming message appears
- final response lands in history

If send fails, classify the failure:

- `Not connected` or missing scope:
  - websocket / runtime preparation issue
- provider/model error:
  - onboarding/config issue
- 502/health failures:
  - runtime dependency issue

### F. Settings validation

Check `Settings` after login/onboarding:

- `Runtime` section should load
- `Worker Bridge Sessions` should refresh correctly
- session list should not flicker back to stale data after refresh/stop
- `Agent Detail` should allow `Start orchestrator`
- stored credential and worker-launch UI should reflect the current agent state

## End-to-end pass criteria

Treat the run as successful only if all of these are true:

- launcher is reachable on `:4100`
- orchestrator is reachable on `:4000`
- API is reachable on `:3100`
- web is reachable on `:5173`
- `/api/auth/state` succeeds after login
- `/health?agentId=<resolved-agent-id>` returns healthy
- `/api/agents/<resolved-agent-id>` returns the runtime-backed agent payload
- login works
- onboarding can complete when required
- runtime preparation succeeds for at least one valid agent
- websocket-backed chat works for at least one session

## Verify work-item snooze locally

Use this when validating the work-item snooze flow alongside the
manager scheduler.

1. Start the platform and runtime with `pnpm run dev` from this repo
   and `pnpm run start:local` from `parallel-agent-runtime`.
2. Log in at `http://127.0.0.1:5173` and use dev credentials if the
   login page appears.
3. Open the work-item list, pick a work item in the current workspace,
   and snooze it for a short interval such as 1 minute.
4. Confirm the work-item row shows a snoozed state, and capture:
   - the current workspace id
   - the manager or active agent id
   - the snoozed work-item id
5. Query the diagnostic endpoint:

```bash
curl -sS "http://127.0.0.1:3100/api/diagnostic/agents/<agent-id>?workspaceId=<workspace-id>&workItemId=<work-item-id>" | jq '.workItems'
```

Expected:

- `items[0].nextPollAt` is the chosen future timestamp.
- `items[0].latestSnoozeEvent.kind` is `work_item.snoozed` when a
  snooze audit row exists.
- The manager status remains `running` or `idle: awaiting credential`;
  snooze affects item selection, not the manager's status line.

To prove wake-up behavior, use the UI's wake action or a webhook path
that updates the item, then refetch the diagnostic endpoint. A ready
item should have `nextPollAt` as `null` or a timestamp at or before
the current time, and it can appear in the next manager batch.

## Common failure cases

### 1. API boots but auth-state or agent routes fail

Likely cause:

- missing `SUPABASE_URL`
- missing `SUPABASE_SERVICE_ROLE_KEY`

### 2. Scoped `/health` is unhealthy

Likely cause:

- orchestrator is not running on `:4000`
- `ORCHESTRATOR_BASE_URL` points at the wrong host/port
- the specific resolved agent runtime is not available

### 3. Web loads but chat never connects

Likely cause:

- API `/ws` proxy is not working
- runtime scope could not be resolved
- runtime preparation failed for the resolved agent

### 4. Login succeeds but app goes to onboarding unexpectedly

Likely cause:

- no usable stored agent
- runtime preparation returned `missing_usable_agent`
- provider/model state is incomplete

### 5. Onboarding saves but worker startup button is unavailable

Likely cause:

- `VITE_WORKER_BRIDGE_DEFAULT_CWD` is missing

### 6. Runtime UI shows healthy but actions still fail

Likely cause:

- launcher is reachable but specific start/session endpoints are failing
- stale agent or credential metadata in Supabase

## Recommended agent workflow

When an agent is asked to "make sure this repo is running end to end," it should follow this order:

1. Verify launcher and orchestrator ports first.
2. Verify `apps/api/.env` and `apps/web/.env.local` have the required values.
3. Start this repo with `pnpm run dev`.
4. Probe `/livez` and the web root first.
5. Log in and verify `/api/auth/state`.
6. Use the resolved agent id to probe scoped `/health?agentId=...` and `/api/agents/<agent-id>`.
7. Validate:
   - login
   - onboarding
   - runtime preparation
   - websocket chat
   - settings/runtime sections
8. Only call the run successful after both process-level checks and UI flow checks pass.

## Related docs

- [End-to-end production smoke runbook](./end-to-end-prod-smoke-runbook.md) — the prod counterpart to this doc.
- [README.md](../../README.md)
- [apps/api/docs/LOCAL_DEV.md](../../apps/api/docs/LOCAL_DEV.md)
- [apps/api/README.md](../../apps/api/README.md)
- [launcher-architecture-and-cross-repo-integration.md](./launcher-architecture-and-cross-repo-integration.md)
- [launcher-integration-pr-plan.md](./launcher-integration-pr-plan.md)
- [apps/web/docs/model-agnostic-startup-notes.md](../../apps/web/docs/model-agnostic-startup-notes.md)
