# Agent Health Diagnostic — Platform PR Plan

Operational checklist for the **platform-side (Tier 2)** of the Agent
Health Diagnostic work. Triggered by a production incident in which a
user opened a workspace, started chatting with a Coding Agent, and hit a
runtime crash (`:badarg` on `port_command` because the `codex` CLI was
missing from the container) with zero up-front signal that the agent
was non-functional.

The fix is layered:

- **Tier 1 — Runtime-side startup inventory.** Lives entirely in
  `parallel-agent-runtime`. Boots a per-agent dry-run probe at
  orchestrator start, exposes the results internally, and adds a
  batch probe endpoint the platform can call. **This repo does not
  own Tier 1.** See the companion doc
  `parallel-agent-runtime/apps/orchestrator/docs/agent-health-diagnostic-pr-plan.md`
  for the `RT-DIAG-1..6` PRs.
- **Tier 2 — User-facing diagnostic surface.** The platform owns the
  API proxy endpoint, the dashboard widget, and the auto-probe on
  workspace open / login. Backed by the runtime probe endpoint
  delivered in `RT-DIAG-5/6`.

This doc scopes **only** the platform-side `PLAT-DIAG-1..4` PRs. Do not
add Tier 1 items here.

## Status legend

| Status | Meaning |
|---|---|
| 🟢 Ready to start | No upstream deps; pick up now |
| 🟡 Blocked | Has a prerequisite still in flight |
| ✅ Shipped | Merged into main |

## PRs in this repo

### 🟡 PLAT-DIAG-1 — Diagnostic API proxy endpoint

**What.** Add `GET /api/diagnostic/workspace/:workspaceId/agents` to
`apps/api/src/routes/`. The handler calls the runtime's
`GET /api/v1/diagnostic/workspace/:workspace_id/agents` endpoint
(delivered by `RT-DIAG-6`) and returns the result to the web client.
Auth: `requireAuth` + `assertWorkspaceMembership` — standard pattern.

Add a Zod response contract in `contracts/agent-health.ts` that
mirrors the runtime response shape (per-agent: `agentId`, `runnerKind`,
`status` ∈ `ok` / `error` / `pending`, `errorCode?`, `errorDetails?`)
so the dashboard can type-check against it. Snake_case at the runtime
boundary, camelCase at the API boundary per the case-conventions rule.

Failure handling: if the runtime endpoint is unreachable or returns
5xx, the API returns a structured
`{ ok: false, reason: "runtime_unreachable", details: "..." }` payload
— the dashboard widget surfaces "orchestrator down" cleanly rather
than swallowing the error. No silent fallbacks; the
surface-DB-errors rule applies to upstream runtime errors too.

**Prerequisites.** Runtime `RT-DIAG-6` deployed to production. Until
then, the endpoint can land but will always return the unreachable
response in prod.

**Independent.** Can begin contract scaffolding and the route stub
immediately. Cannot complete an e2e green path until `RT-DIAG-6`
ships.

**Validation.** Contract test asserting the response shape. API unit
test mocking the runtime call (200 happy path + unreachable path).
`pnpm -C apps/api run validate`.

**Unblocks.** `PLAT-DIAG-2` (widget), `PLAT-DIAG-3` (auto-probe).

---

### 🟡 PLAT-DIAG-2 — Dashboard health widget

**What.** New React component in `apps/web/` that fetches
`/api/diagnostic/workspace/:id/agents` when a workspace is opened.
Renders a per-agent health line: green check / red x / pending
spinner.

For broken agents, show the error code + a one-line human-readable
explanation derived from a small client-side mapping. Example entry:

```
runner_spawn_failed.bash_port_dead.codex →
  "Coding Agent can't start — codex CLI missing in container,
   contact ops."
```

Place the widget near the top of the workspace dashboard so it's the
first thing users see if their agents are broken. If the proxy
returns `{ ok: false, reason: "runtime_unreachable" }`, render a
distinct "Orchestrator unreachable" state rather than a per-agent
list.

**Prerequisites.** `PLAT-DIAG-1`.

**Independent.** No.

**Validation.**
`pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`. Browser smoke
per CLAUDE.md "Testing — REQUIRED For UI/Frontend Changes": log in
with dev credentials, open a workspace with a healthy agent, then
simulate a broken-agent response (mock the proxy) and confirm the
red-x line + error explanation render.

**Unblocks.** `PLAT-DIAG-3`.

---

### 🟡 PLAT-DIAG-3 — Auto-probe on workspace open / login

**What.** Wire the diagnostic call to fire automatically on:

- **Login** — probe the user's last-active workspace.
- **Workspace switch** — probe the newly-selected workspace.

Cache results for ~30 seconds (client-side, e.g. React Query
`staleTime`) so rapid navigation doesn't hammer the runtime. If any
agent is in `error` state, show a dismissible banner at the top of
the page summarising "N agents need attention" with a click-through
to the widget from `PLAT-DIAG-2`. The banner is dismissible
per-session but re-appears on each workspace switch.

**Prerequisites.** `PLAT-DIAG-2`.

**Independent.** No.

**Validation.** Browser smoke: simulate a broken-agent state in a test
workspace, log in, confirm the banner appears; switch to a healthy
workspace, confirm the banner clears; switch back, confirm it
re-appears (i.e. dismissal does not leak across workspaces).

---

### 🟢 PLAT-DIAG-4 — Cross-repo enum drift check for diagnostic error codes

**What.** Extend `scripts/check-cross-repo-enums.mjs` to assert that
the platform's `DiagnosticErrorCode` enum (defined alongside the
contract added in `PLAT-DIAG-1`) is a superset of the runtime's
`agent_probe_error` allowed values. Same pattern as the existing
`runner_kind` / `tracker_kind` drift checks. Update
`.github/workflows/cross-repo-enum-drift.yml` if new file paths are
added.

Catches the bug class where the runtime adds a new probe error code
but the platform's UI has no mapping for it and falls back to "Unknown
error" — defeating the point of the diagnostic.

**Prerequisites.** Runtime has stabilised the error-code enum (around
the `RT-DIAG-5` timeframe). Can start the script change immediately;
hold the merge until the runtime list is reasonably stable so we're
not chasing a moving target.

**Independent.** Mostly. The script edit is self-contained; only the
merge is gated on the upstream list stabilising.

**Validation.** Run the drift script locally against current main;
should pass. Add a unit-style assertion that an injected mock runtime
enum with an extra value fails the check (regression protection on
the script itself).

## Cross-repo dependencies

| When this repo's PR is ready, the upstream PR must be merged: |
|---|
| `PLAT-DIAG-1` (proxy endpoint) — runtime `RT-DIAG-6` (batch probe endpoint) |
| `PLAT-DIAG-2` (widget) — `PLAT-DIAG-1` |
| `PLAT-DIAG-3` (auto-probe) — `PLAT-DIAG-2` |
| `PLAT-DIAG-4` (drift check) — runtime `RT-DIAG-5` (error-code list stable) |

| What this repo's PRs unblock: |
|---|
| `PLAT-DIAG-1` → `PLAT-DIAG-2` (widget), `PLAT-DIAG-3` (auto-probe), both in platform |
| `PLAT-DIAG-2` → `PLAT-DIAG-3` (auto-probe), platform |
| `PLAT-DIAG-3` → user-facing only; no structural downstream |
| `PLAT-DIAG-4` → guardrail; no structural downstream |

## Reference

- Original conversation that scoped this work (today's session — the
  codex-missing crash incident).
- Runtime companion PR plan:
  `parallel-agent-runtime/apps/orchestrator/docs/agent-health-diagnostic-pr-plan.md`
  (`RT-DIAG-1..6`).
- Manager smoke runbook (in the runtime repo) — useful context for
  what "agent is healthy" means operationally.
