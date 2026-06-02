# Testing Strategy — What Working Means

How we test that the app is actually working, locally and in AWS. This doc
defines:

1. **The canonical user story** that any "is the app working" check validates.
2. **What counts as a regression** — stated precisely enough that a reviewer
   can point at a failing assertion.
3. **The test pyramid** we want, current gaps, and what to build to close them.
4. **Smoke checks** for local dev and post-deploy AWS verification.

This is a strategy doc, not a runbook. For step-by-step local setup see
[`docs/end-to-end-local-runbook.md`](./end-to-end-local-runbook.md) and
[`docs/local-e2e-testing.md`](./local-e2e-testing.md). For unit-test setup in
the platform API see
[`parallel-agent-platform/apps/api/docs/TESTING.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/apps/api/docs/TESTING.md).

> **Mirrored.** This doc also lives in the platform repo at
> [`docs/testing-strategy.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/testing-strategy.md).
> Keep them in sync when editing.

---

## 1. The canonical user story

Everything in this doc rolls up to one browser-level user story. If all
assertions below hold against a freshly-started stack, **the app is working**.

### Scenario: First-time user logs in, lands on dashboard, sends a message

```
Given a fresh browser session at http://127.0.0.1:5173 (local) or the
      deployed web URL (staging/prod)
When  the user signs in with valid Supabase credentials
Then  the user lands on /dashboard/:agentId within 10 seconds
And   the dashboard shows the agent's status = "running"
And   the WebSocket at /ws emits a `hello-ok` frame within 2 seconds
When  the user types "hello" and submits the chat input
Then  the WebSocket emits an event with role="assistant" within 30 seconds
And   the assistant content is a non-empty string
And   (once OR-7 ships) the message pair is persisted to Supabase `message`
      and visible on page reload
```

### Acceptance assertions (browser-level)

| Assertion | How we check |
|---|---|
| A1. Login redirects to `/dashboard/:agentId` | URL matcher after `onSignIn` resolves |
| A2. Dashboard shows agent status badge = `running` | DOM selector on the badge element |
| A3. `GET /api/v1/health` responds 200 through the proxy | Network tab / Playwright `waitForResponse` |
| A4. WS connects and emits `hello-ok` | Message-sniff on the WS at open |
| A5. `chat.send` → runner-complete round trip | User types, assistant response appears in the DOM |
| A6. Assistant message text length > 0 | DOM text read |
| A7. (OR-7) Reload preserves the message pair | Navigate away and back, read DOM |

Anything else — settings pages, onboarding wizards, admin views — is **not**
part of the canonical story. We cover those through targeted integration tests
and manual QA, not the smoke gate.

---

## 2. What counts as a regression

A regression is **any commit that breaks one of the A1–A7 assertions**, or
**re-introduces a documented class of failure** from §9. Specifically:

- **User-visible regression** — a change that makes the canonical scenario
  fail. Blocks merge.
- **Integration regression** — unit tests pass but the scenario fails.
  Indicates a gap between unit tests and real-world wiring; the PR must
  either add an integration test that catches it, or document why it can't.
- **Silent regression** — the scenario still passes but a side channel is
  broken (e.g. a message is no longer persisted to `broker_run`, telemetry
  stops flowing). Still a regression; add a test that catches it before the
  next silent failure.

**Not a regression:**
- Changes to internals that don't change user-observable behavior.
- Performance changes within the scenario's timeout windows.
- New features that add UI surfaces the canonical scenario doesn't cover.

---

## 3. Test pyramid — current vs target

```
                         Target
                      ┌──────────┐
                      │ Browser  │  Playwright, ~5–8 scenarios,
                      │   E2E    │  run on PR + nightly against staging
                      └──────────┘
                    ┌──────────────┐
                    │ API / int.   │  vitest + mix test
                    │              │  run on every PR
                    └──────────────┘
                 ┌────────────────────┐
                 │     Unit tests     │  vitest + mix test
                 │                    │  run on every PR
                 └────────────────────┘

                         Today
                      ┌──────────┐
                      │  NONE    │  ← we have zero automated browser tests
                      └──────────┘
                    ┌──────────────┐
                    │ partial      │  vitest covers API routes; mix test
                    │              │  covers adapters. No cross-service.
                    └──────────────┘
                 ┌────────────────────┐
                 │     good-ish       │  decent in both repos, some gaps
                 └────────────────────┘
```

The top layer is the biggest gap. Every "did it work" check we do today is
either manual curl against a local stack or a human opening the browser.
Adding Playwright is the highest-leverage investment.

---

## 4. Level 1 — Unit tests

### Runtime (`parallel-agent-runtime`)

- **Runner:** `mix test` from `apps/orchestrator`. ~500 tests at last count.
- **Scope:** adapters, Ecto schemas, configuration, workspace handling, the
  launcher GenServer.
- **Gaps:** no Elixir-side JWT test (not needed under Option B of the auth
  design); broker_log / gateway_config tests hit real Supabase patterns but
  are largely mocked.

### Platform (`parallel-agent-platform`)

- **Runner:** `pnpm test` in `apps/api` (vitest).
- **Scope:** route handlers, proxy behavior, launcher-client retries.
- **Gaps:** **zero tests on `apps/web`.** No `*.test.ts(x)` files. Every
  React component, every auth-store method, every fetch hook is untested at
  the unit level.

**Action items:**
- [ ] Add vitest + `@testing-library/react` setup to `apps/web`. Start with
      the auth store (`src/stores/auth.ts` or equivalent) and the
      broker client (`src/api/broker.ts`).
- [ ] Add Elixir unit tests for `MessageLog` (when OR-7 lands).

---

## 5. Level 2 — API / integration tests

### Runtime

- **Live E2E test:** `pnpm run test:e2e` in runtime repo runs
  `SYMPHONY_RUN_LIVE_E2E=1 mix test test/symphony_elixir/live_e2e_test.exs`.
  Spins up launcher + orchestrator, polls the API tracker, verifies a Codex
  round-trip. Heavy — not for every PR.
- **Gap:** no test covering platform-to-launcher HTTP contract. If the
  platform team changes a query-param name on the WS, we find out via a
  broken staging demo.

### Platform

- **Vitest integration:** `apps/api/src/**/*.integration.test.ts` covers
  setup flow, launcher-proxy behavior, auth-state endpoints against mocked
  launchers.
- **Gap:** no test opens a real WS through the proxy and round-trips a
  message to a real runtime.

**Action items:**
- [ ] Add a "platform → runtime contract test" to one of the two repos that
      starts both services and runs a single POST → WS round trip. One test
      catches 80% of the cross-repo breakage that today surfaces as "the
      demo is broken on Monday."

---

## 6. Level 3 — Browser E2E tests (new)

This is the layer we don't have today and need to build.

### Framework pick: **Playwright** (decided)

- Consistent with the TypeScript stack the web client already uses.
- First-class WebSocket test APIs (`page.waitForEvent('websocket')`, frame-
  level assertions) — matters because A4 / A5 test frames, not just HTTP.
- Headless in CI, headed locally for debugging.
- Cypress was the alternative; Playwright's WebSocket story is stronger,
  which decided it.

### Credentials and environment variables

Playwright needs a dedicated Supabase test user per environment. **Never
use a real user's credentials** — the suite will sign in repeatedly and
may produce DB side effects. Provision one test user for local, one for
staging, one for prod. They can share the same email prefix with different
domains / aliases, but the Supabase rows are distinct.

#### Env vars (same names everywhere; values differ by environment)

| Var | Purpose | Secret? |
|---|---|---|
| `PLAYWRIGHT_BASE_URL` | Which web URL the suite hits (`http://127.0.0.1:5173` locally, `https://<staging>` in CI, `https://<prod>` for the synthetic monitor) | No — set as a repo/env variable |
| `PLAYWRIGHT_USER_EMAIL` | Test user email for the target environment | **Yes** |
| `PLAYWRIGHT_USER_PASSWORD` | Test user password for the target environment | **Yes** |
| `PLAYWRIGHT_AGENT_ID` | Known agent UUID owned by the test user; lets tests skip onboarding and land straight on `/dashboard/:id` | No — environment variable |
| `PLAYWRIGHT_WORKSPACE_ID` | Workspace UUID the test agent lives in; used by WS-scope tests | No — environment variable |

The three Supabase rows to create per environment:

1. **A user** in the Supabase `auth.users` table. Record the email + password.
2. **A workspace** owned by that user. Record the `workspace_id` UUID.
3. **An agent** attached to the workspace in a known state (e.g. `status: "running"`). Record the `agent_id` UUID.

#### GitHub Actions wiring

Put the two **secrets** in GitHub Actions repo secrets (or per-environment
secrets if you're using GitHub Environments):

- `PLAYWRIGHT_USER_EMAIL`
- `PLAYWRIGHT_USER_PASSWORD`

Put the three **variables** as GitHub Actions repo variables or environment
variables (non-secret):

- `PLAYWRIGHT_BASE_URL`
- `PLAYWRIGHT_AGENT_ID`
- `PLAYWRIGHT_WORKSPACE_ID`

If you use three GitHub Environments (`local-mirror`, `staging`, `prod`),
each one overrides the values appropriately and the workflow job picks
the right environment based on what it's running against.

#### Local dev `.env`

```
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5173
PLAYWRIGHT_USER_EMAIL=e2e-local@example.com
PLAYWRIGHT_USER_PASSWORD=<paste here, do not commit>
PLAYWRIGHT_AGENT_ID=<uuid>
PLAYWRIGHT_WORKSPACE_ID=<uuid>
```

Add that block to `apps/web/.env.example` (committed) with empty values so
new devs know what they need. The populated `.env` stays gitignored.

### Test suite scope (first cut)

~5–8 scenarios. Keep it small — every scenario costs CI time and flake
budget.

| # | Scenario | Covers assertions |
|---|---|---|
| 1 | **Happy path — login + send message** | A1, A2, A4, A5, A6 |
| 2 | **Login → dashboard → page reload** | A1, A2 (session persistence) |
| 3 | **Send message → assistant responds within 30s** | A5, A6 |
| 4 | **WS reconnect after network blip** | A4 (resilience) |
| 5 | **Unauthenticated user hits `/dashboard/:agentId` → redirected to login** | Auth guard |
| 6 | **Invalid credentials → error message** | Auth error path |
| 7 | (OR-7) **Reload preserves chat history** | A7 |
| 8 | (PL-4 ingested) **Work item shows up in dashboard** | External ingest regression |

### Where the suite lives

`parallel-agent-platform/apps/web/tests/e2e/` — colocated with the web
client. Run via `pnpm run test:e2e` in `apps/web`.

### Test data

- **Dedicated test user** in Supabase with a known password (stored in
  `PLAYWRIGHT_USER_EMAIL` / `PLAYWRIGHT_USER_PASSWORD` env, CI secret in
  prod). Never reused for human login.
- **Dedicated test agent** attached to that user with a known `agent_id`.
- Tests are **read-mostly**. The only writes are chat messages, which land
  in the dedicated user's session_thread and can be cleaned up by a
  `beforeEach` that deletes their messages (or left to accumulate — they're
  scoped to one test user).

### What Playwright does *not* replace

- Unit tests for components/stores.
- API-level integration tests in `apps/api`.
- Elixir tests for the orchestrator / Ecto layer.

Playwright tests are expensive. Keep them focused on user-visible behavior;
use the layers below for everything else.

---

## 7. Smoke tests

### Local dev (human operator)

Prereq: `mix launcher.start` + `pnpm run dev` both up.

1. `curl http://127.0.0.1:4100/health` → 200
2. `curl http://127.0.0.1:3100/livez` → 200
3. `curl http://127.0.0.1:5173/` → 200
4. Browser to `http://127.0.0.1:5173/` → login page renders.

If all four pass, the stack is structurally up. The canonical scenario
(§1) is what verifies it's *working*.

### Local automated smoke

- `pnpm run smoke:runtime` in runtime → checks launcher health,
  orchestrator health, and launcher-side direct database connectivity
  (`database.connected=true` from `/health`). Run this after changes to
  launcher startup, env loading, Ecto/Supabase access, or gateway routing.
- `pnpm run smoke:manager -- --workspace-id <workspace-id>` in runtime →
  checks that the manager scheduler is configured, has a recent successful
  tick, reports no `last_error`, and has provider/model/credential metadata.
  Run this after changes to manager-agent setup, manager scheduling,
  `work_items` polling, gateway config resolution, or credentials.
  When this smoke fails, search runtime logs by the returned `trace_id` or by
  `workspace_id` for `manager_scheduler_tick_failed`,
  `manager_work_item_poll_failed`, and `manager_work_item_poll_skipped`.
  The scheduler logs include `scheduler_health`, `last_error_code`,
  `skip_reason`, `due_count`, `picked_count`, and `skipped_count` so "nothing
  happened" cases can be separated from database/profile failures.
- `pnpm run test:e2e` in runtime → spins everything up, asserts one
  launcher/orchestrator round-trip. Slow but thorough.
- Once Playwright lands: `pnpm run test:e2e` in `apps/web` → runs the
  scenario set against a local stack. Target: < 2 minutes.

### AWS post-deploy

See §10 below.

---

## 8. Regression catalog

Concrete failure modes we've either hit recently or have strong reason to
expect. Each should have an automated test that catches it going forward.

| Regression | Surface | Current coverage | Fix / test to add |
|---|---|---|---|
| PostgREST base URL missing `/rest/v1` | Launcher fails to resolve agents; 404 from Supabase; API returns 422 | [parallel-agent-runtime#46](https://github.com/kmgrassi/parallel-agent-runtime/pull/46) — `SymphonyElixir.Supabase` helper + unit tests | Good ✅ |
| Vendored `postgrest-schema.json` drifts from live `work_items` / `gateway_config` | Runtime 500s on first use of a new table | Manual — must re-run `scripts/append-supabase-jsdoc-types.mjs` | Add a CI check that fails if regenerating would diff the committed file |
| Launcher binds to `0.0.0.0` on a network-exposed host | Undermines Option B auth isolation | [parallel-agent-runtime#60](https://github.com/kmgrassi/parallel-agent-runtime/pull/60) — loopback default + unit tests | Good ✅ |
| Platform changes WS scope param name | `connect` fails silently; dashboard stays on loading | No contract test | A cross-repo contract test (see §5 action item) |
| `message` table gets a `NOT NULL` column we don't populate | Insert fails, chat appears to work but history is empty | No test | OR-7 integration test + the CI schema-drift check |
| Launcher starts without direct DB access | Manager scheduler reports running but due-work polling fails at runtime | `pnpm run smoke:runtime` checks `/health.database.connected`; `pnpm run smoke:manager -- --workspace-id <id>` checks clean manager tick | Good ✅ |
| Manager Ecto row schema drifts from live `work_items` columns | Manager tick crashes before it can pass due items to the LLM | `pnpm run smoke:manager -- --workspace-id <id>` against a live stack | Good ✅ |
| Runtime verifies JWT incorrectly (if we ever go Option A) | Valid users rejected, or invalid tokens accepted | N/A today | JWT-verifier unit tests against Supabase JWKS fixtures |
| Web client fails to render on a route | Users see a blank page | No test | Playwright suite (§6) |
| Auth-store regressions (token expiry, refresh) | Random 401s for signed-in users | No test | `apps/web` unit tests (§4 action item) |

Add a new row to this table whenever an outage, revert, or hotfix
traces back to a class of bug we didn't already have an automated gate for.
Over time this table becomes the real definition of "regression."

---

## 9. AWS / prod verification

### Post-deploy smoke check (checklist form today, script later)

After a deploy to staging or prod:

- [ ] ECS service status: all tasks `RUNNING`, target group health `healthy`.
- [ ] `curl https://<orchestrator>/api/v1/health` → 200 (through the internal
      ALB — requires bastion or VPC access today; put this behind a CI job
      with VPC connectivity).
- [ ] `curl https://<platform-api>/livez` → 200.
- [ ] Open the deployed web client, sign in as the test user, send a
      message. **This is the A1–A6 subset of §1 executed against prod.**
- [ ] Check CloudWatch logs for the orchestrator task: no `[error]` lines
      in the last 5 minutes.
- [ ] Check CloudWatch logs for the platform API task: no `5xx` from the
      launcher proxy in the last 5 minutes.

### Action items for prod verification automation

- [ ] Add an **ALB health-check path** to the orchestrator's Terraform. The
      existing target group uses `/api/v1/state` ([main.tf:235](../apps/orchestrator/deploy/terraform/main.tf#L235));
      that's fine but not documented. Add a comment + an assertion in
      `apps/orchestrator/deploy/aws.md`.
- [ ] Add a **post-deploy Playwright run against staging** as a GitHub
      Actions job. Same scenario set as §6, different base URL. Gates
      the prod promotion.
- [ ] Add a **synthetic monitor** (CloudWatch Synthetics or a self-hosted
      cron) that runs the happy path against prod every 5 minutes and
      pages on failure. Browser-level, not HTTP-level — catches the
      things a `/health` 200 misses.

### What's deliberately out of scope

- Load testing. Relevant later; not part of "is the app working."
- Chaos testing. Same.
- Per-region failover. We're single-region today.

---

## 10. Implementation roadmap

### Phase 1 — Close the biggest gaps (1–2 small PRs each)

1. **Playwright bootstrap** in `apps/web` — framework, config,
   `PLAYWRIGHT_USER_*` env, one scenario (the happy path, §6 #1). CI job
   that runs it against a local stack.
2. **Schema-drift CI check** — fail the build if
   `scripts/append-supabase-jsdoc-types.mjs` produces a diff. Closes the
   "vendored schema stale" regression from §8.
3. **ALB health-check path doc + comment** in `aws.md` + Terraform.

### Phase 2 — Fill out the suite

4. **4–5 more Playwright scenarios** from the §6 table.
5. **Cross-repo contract test** — one PR in either repo that spins up
   both and round-trips a POST through the WS (§5 action item).
6. **`apps/web` unit tests** — auth store, broker client, any component
   with non-trivial logic.

### Phase 3 — Automate prod verification

7. **Staging Playwright run as a post-deploy GitHub Action.**
8. **Prod synthetic monitor** that runs the happy path on a 5-minute cron.
9. **Post-deploy smoke script** checking CloudWatch logs for
   error/5xx patterns in the 5 minutes after deploy.

Each phase is independently valuable — we can stop at Phase 1 and still
have strictly better regression detection than today.

---

## Appendix — References to existing docs (do not duplicate)

- [`docs/local-e2e-testing.md`](./local-e2e-testing.md) — manual local E2E
  (Linear + Codex path, in-memory API tracker path).
- [`docs/end-to-end-local-runbook.md`](./end-to-end-local-runbook.md) —
  5-minute quickstart for all four services.
- [`apps/orchestrator/WORKFLOW.local-e2e.md`](../apps/orchestrator/WORKFLOW.local-e2e.md)
  — minimal smoke workflow definition.
- [`apps/orchestrator/deploy/aws.md`](../apps/orchestrator/deploy/aws.md) —
  AWS deployment specifics.
- [platform `apps/api/docs/TESTING.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/apps/api/docs/TESTING.md)
  — vitest unit-test conventions.
- [platform `apps/api/docs/LOCAL_DEV.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/apps/api/docs/LOCAL_DEV.md)
  — platform API local setup + curl verification.
