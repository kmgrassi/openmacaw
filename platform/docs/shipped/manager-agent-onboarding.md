# Manager Agent — Onboarding & UX

Platform-side companion to the runtime design at
`parallel-agent-runtime/apps/orchestrator/docs/manager-agent.md`.

This doc covers the **API contract changes** and the
**frontend UX** for auto-provisioning a workspace's manager
agent during first-time setup. The runtime side covers what the
agent does once running; this side covers how it gets created
and configured.

> **Status:** design-only. The implementation sequence lives in
> [`manager-agent-default-login-pr-plan.md`](./manager-agent-default-login-pr-plan.md).

## What we're optimizing for

- **Zero-decision onboarding.** A new user lands, supplies their
  Anthropic API key, and a manager agent is running 60 seconds
  later. They never have to know it exists unless they want to
  override defaults.
- **One-screen first run.** No multi-step wizard, no "advanced
  settings collapsible." If you have an API key, you're done.
- **Override later, not now.** Settings page exposes model /
  cadence / provider swaps, behind one click. Most users never
  touch it.
- **No new infra.** The bootstrap path
  (`POST /api/setup` → `createSetup`) already provisions
  agent + credential + model + `gateway_config` + runner
  atomically. We extend it; we don't reinvent it.

## What exists today

Audited against `parallel-agent-platform` `main` at scope-doc
time:

| Path | What it does |
|---|---|
| `apps/api/src/routes/setup.ts:78-92` | `POST /api/setup` accepts `SetupRequestSchema`, calls `createSetup`. Today wires up planning + coding agents one at a time. |
| `apps/api/src/routes/setup.ts:94-108` | `PUT /api/setup` updates an existing setup. |
| `apps/api/src/routes/setup.ts:110-121` | `GET /api/setup?agentId=…` returns the assembled setup. The response includes `requirements: SetupRequirementStatusSchema` whose `missing[]` array drives the UI's "still need X" cards. |
| `apps/api/src/routes/setup.ts:63-64` | `POST /api/default-agents/credentials` accepts a user-supplied API key and applies it to an existing default agent. |
| `apps/api/src/services/setup.ts` | `createSetup` / `updateSetup` / `getSetup` — orchestrate agent / credential / model / gateway_config / runner inserts with version-history rows in `gateway_config_versions`. Calls `upsertDefaultAssignment(... role='planning'\|'coding', 'platform_bootstrap')` at line 514. |
| `apps/api/src/services/default-agent-credentials.ts` | `applyDefaultAgentCredentials` — applies a user-supplied API key to an existing default agent. Used by `POST /api/default-agents/credentials`. |
| `apps/web/src/App.tsx`, `apps/web/src/stores/auth.ts` | Frontend onboarding flow — references `provisioning_source`, default-agent state. |

The setup response's `requirements.missing` array (defined in
`contracts/setup.ts:140` inside `SetupRequirementStatusSchema`,
exposed at the top level of the response as `requirements`,
line 148) is `Array<{ kind: "agent" | "credential" | "model" |
"gateway_config" | "runner", … }>`. The dashboard already knows
how to render "you still need to provide X" cards based on this
during partial bootstrap. **Note the wrapper** — read paths must
do `response.requirements.missing`, not `response.missing`.

## What changes

The big idea: **the manager exists for every workspace from
the moment the workspace is created** — not when the user
clicks a "set up manager" button. We split *existence* from
*activity*:

- **Existence** (auto, on workspace creation): manager `agent`
  row, `gateway_config.config_json.runners.manager` payload,
  `Manager.Scheduler` GenServer in the runtime.
- **Activity** (when the user supplies a credential): the
  `credential_alias` field gets populated; the next scheduler
  tick picks it up; manager starts dispatching real work.

This means the user is never deciding *whether* to have a
manager — that's not a meaningful choice. They're only
deciding *which API key* the manager should use. If they skip
that, the manager exists but ticks idle, no errors.

### 1. Workspace-creation hook auto-provisions the manager

The platform's workspace-creation path (today: `createWorkspace`
or equivalent — verify exact entrypoint at implementation time)
gets a new responsibility: in the same transaction that inserts
the `public.workspaces` row, also insert:

```
on workspace insert:
  ├─ agent row with type='manager', model='claude-sonnet-4'
  │   (default; overrideable later via gateway_config edit)
  ├─ gateway_config row:
  │    scope_type  = 'workspace'
  │    scope_id    = workspace.id
  │    config_json = {
  │      "runners": {
  │        "manager": {
  │          "model":            "claude-sonnet-4",
  │          "credential_alias": null,         ← populated later
  │          "min_cadence_ms":   60000
  │        }
  │      }
  │    }
  └─ gateway_config_versions row (initial v1)
```

**Crucially, no `credential` row** is created at this point. The
manager exists with a `null` credential_alias. The runtime
scheduler handles this gracefully: ticks on cadence, sees no
credential, no-ops, reports `idle: awaiting credential` status.

The orchestrator side (runtime) is told about the new workspace
via the existing workspace-created event mechanism, which causes
the `Manager.Scheduler` GenServer to start under that
workspace's supervision subtree. Idempotent — restarts and
re-binds are no-ops.

### 2. Credential later flows in via the existing endpoint

When the user provides an API key (via the dashboard's
credential-pasting UI or via SSO/OAuth), the existing
**`POST /api/default-agents/credentials`** endpoint (`apps/api/src/routes/setup.ts:63-64`,
backed by `applyDefaultAgentCredentials` in
`apps/api/src/services/default-agent-credentials.ts`) is
extended to support the manager:

1. Insert the `credential` row (envelope-encrypted, as for
   other agents).
2. Update `gateway_config.config_json.runners.manager.credential_alias`
   to point at the new credential. Write a new
   `gateway_config_versions` row.
3. **Do NOT call `upsertDefaultAssignment`.** That table is
   per-user (keyed `(workspace_id, user_id, role)`) and the
   manager is workspace-singleton. See the runtime-side doc
   for the full rationale; in short, calling
   `upsertDefaultAssignment` with `role='manager'` would either
   force extending the role enum to a value with no semantic
   meaning, or require sentinel `user_id` values that introduce
   ambiguity.

The next tick of `Manager.Scheduler` reads the updated
`gateway_config` payload — no restart needed — and starts
dispatching real work.

### 3. What is NOT changing in the setup endpoint

Earlier drafts of this doc proposed adding `role: 'manager'` to
`SetupRequestSchema` and routing manager provisioning through
`POST /api/setup`. **We are no longer doing that.** Reasons:

- `POST /api/setup` is per-agent and assumes user-driven
  invocation. The manager isn't user-driven; it's
  workspace-created-driven.
- Putting the manager creation behind `POST /api/setup` means
  the manager doesn't exist until the user clicks something.
  That's the gated-on-user-click anti-pattern we want to avoid.
- Workspace-creation is the right cardinality for the manager
  (one per workspace). `POST /api/setup` is a per-agent
  endpoint and would need awkward special-casing to honor
  workspace-singleton semantics.

The manager's overrides (model swap, cadence change) are still
exposed via `PUT /api/setup` once an agent_id is known —
because once it exists, it's just an agent, and the existing
agent-config endpoints work. The first creation is what's
different, not the lifetime management.

### 4. First-run UX — activate the manager

Because the manager already exists by the time the user lands
in the dashboard, the framing of the onboarding screen shifts
from "set up your workspace" (decision) to "activate your
manager" (just supply a credential).

Two states, depending on whether a reusable credential is
already in the workspace:

#### State A — no reusable credential

```
┌─────────────────────────────────────────────────────────────┐
│  Activate your manager agent                                 │
│                                                              │
│  Your workspace's manager agent is set up and ready, but it  │
│  needs an API key before it can run. Paste an Anthropic key  │
│  to give it credentials, or skip for now and add one later.  │
│                                                              │
│    Anthropic API key  [ sk-ant-api03-…………………… ]              │
│                                                              │
│    [ Skip for now ]                       [ Activate ]      │
│                                                              │
│  Why Anthropic? Claude Sonnet is our recommended default     │
│  for the manager. You can switch providers anytime in        │
│  Settings → Manager Agent.                                   │
└─────────────────────────────────────────────────────────────┘
```

`Activate` calls `POST /api/default-agents/credentials` with
the manager's agent_id and the API key:

1. Backend inserts the `credential` row.
2. Backend updates `gateway_config.config_json.runners.manager.credential_alias`
   (writes a new `gateway_config_versions` row).
3. Runtime's `Manager.Scheduler` picks up the change on its
   next tick.

`Skip for now` dismisses the screen. The manager continues to
exist in `idle: awaiting credential` state. The dashboard's
"missing setup" banner (next section) keeps the activation
nudge visible.

#### State B — workspace already has a reusable credential

If a planning/coding agent has already authenticated against
Anthropic and the credential is reusable for the manager:

```
┌─────────────────────────────────────────────────────────────┐
│  Activate your manager agent                                 │
│                                                              │
│  Your workspace's manager agent is set up and ready, but it  │
│  needs a credential. Use your existing Anthropic key, or     │
│  add a separate one.                                         │
│                                                              │
│    [ Use "Default Anthropic key" ]    [ Add a new API key ]  │
└─────────────────────────────────────────────────────────────┘
```

`Use "Default Anthropic key"` calls
`POST /api/default-agents/credentials` referencing the existing
`credential.id` (no plaintext key required, just a re-link).
The same `gateway_config` update path runs.

`Add a new API key` falls through to State A.

#### What the user can never see

There's no "manager not yet created" UX state. The manager
exists for every workspace, always. The only states are
`idle: awaiting credential` (no key) and `running` (key
attached). This is intentional — removing "create" from the
user's set of decisions removes the most common drop-off
point in onboarding.

### 3. Settings: Manager Agent

`apps/web/src/pages/settings/manager-agent.tsx` (new). Reads
the current `gateway_config.config_json.runners.manager` payload
via `GET /api/setup?agentId=<manager agent id>` and lets the
user override:

```
┌─────────────────────────────────────────────────────────────┐
│  Settings › Workspace › Manager Agent                        │
│                                                              │
│  Provider                                                    │
│    [ Anthropic              ▾ ]                              │
│  Model                                                       │
│    [ Claude Sonnet 4         ▾ ]                             │
│  Cadence                                                     │
│    Check work every                                          │
│    [ 5 minutes               ▾ ]   (10s — 1 hour)            │
│  Credential                                                  │
│    Default Anthropic key  ↗ Manage credentials               │
│                                                              │
│    Status: ● Running — last tick 12s ago                     │
│                                                              │
│                                          [ Save changes ]   │
└─────────────────────────────────────────────────────────────┘
```

The "Status" line polls a small new
`GET /api/runtime/manager-status` endpoint every 15s while the
page is visible. Possible status values:

- `idle: awaiting credential` — manager exists, scheduler is
  ticking, but no `credential_alias` is set. UI shows a
  contextual "Add a credential" button.
- `running` — credential present, last tick succeeded. Shows
  `last_tick_at` relative time.
- `error` — last tick failed. Shows a brief error explainer
  and a "View logs" link.

The manager status is not a count of runnable work. Snoozing a
`work_item` only moves that item's `next_poll_at` into the future;
it does not pause the manager, change this status line, or stop the
scheduler from ticking. Snoozed items simply do not appear in the
next manager batch until their `next_poll_at` is due, or until a
webhook or wake action pulls them forward.

`Save changes` calls `PUT /api/setup` with the new payload (the
manager already exists by `agent_id`, so this is just an
update). `gateway_config_versions` gets a new row for free.

### 5. Skip-for-now banner

When `requirements.missing` includes the manager's missing
credential, every page in the dashboard shows a single
dismissible banner:

```
⚠ Your manager agent is idle — add an API key to activate it.    [ Activate ]   ✕
```

Sourced from the workspace's `requirements.missing` field
(the wrapper matters: read path is
`response.requirements.missing`, not `response.missing`).
Dismissing stores a per-user preference; the banner returns
on next session unless the credential has been added.

The framing is "idle, add to activate" — not "not running,
set up now." This matches the new design: the manager always
exists, it's just unfueled.

## API surface to add or extend

| Endpoint | Change |
|---|---|
| Workspace-creation hook (existing — verify entrypoint at impl time) | Insert `agent` row (type=manager), `gateway_config` row + `gateway_config_versions` row, fire workspace-created event so the runtime starts the `Manager.Scheduler` |
| `POST /api/default-agents/credentials` (`apps/api/src/routes/setup.ts:63-64`) | Accept manager `agent_id`. On insert, also update `gateway_config.config_json.runners.manager.credential_alias`. **Must NOT** call `upsertDefaultAssignment` for the manager. |
| `PUT /api/setup` (`apps/api/src/routes/setup.ts:94-108`) | Existing endpoint — used to update model / cadence / credential alias once the manager exists by `agent_id`. No new shape needed. |
| `GET /api/setup?agentId=<manager>` (`apps/api/src/routes/setup.ts:110-121`) | Existing endpoint — returns the manager's current setup including `requirements.missing` for any pieces still pending (typically just the credential). |
| `GET /api/runtime/manager-status` (new) | Returns `{ workspace_id, status: 'idle_awaiting_credential' \| 'running' \| 'error', last_tick_at, last_decision_count, error?: string }` — proxies to the runtime's `Manager.Scheduler` for the workspace. |

Auth on all five: existing user JWT middleware + workspace-
membership check.

The earlier draft of this doc had `POST /api/setup` accept
`role: 'manager'`. We're not doing that — manager creation
moved to workspace-creation time.

## Frontend work

| File | Change |
|---|---|
| Workspace-creation flow in the platform API | Server-side, not frontend, but the workspace-creation hook is what makes the manager-exists state real. Listed here so it's not forgotten. |
| `apps/web/src/pages/onboarding/activate-manager.tsx` (new) | "Activate your manager" screen — State A / State B branches. Calls `POST /api/default-agents/credentials`. |
| `apps/web/src/pages/settings/manager-agent.tsx` (new) | Settings UI with provider/model/cadence overrides + status line. Polls `GET /api/runtime/manager-status`. |
| `apps/web/src/components/MissingSetupBanner.tsx` (new or extend existing) | Reads `response.requirements.missing` and renders the dismissible banner when the manager's credential is missing. |
| `apps/web/src/api/manager-agent.ts` (new) | Thin client wrappers around the endpoints above. |

## Test plan

- [ ] Workspace creation alone → manager `agent`, `gateway_config`, and scheduler GenServer all created with no user interaction. `requirements.missing` reports the credential as the only outstanding requirement.
- [ ] Fresh workspace + activate via API key → manager transitions from `idle: awaiting credential` to `running` on the next tick.
- [ ] Fresh workspace + skip → manager remains in `idle: awaiting credential`, no errors in logs, banner sourced from `requirements.missing` is visible.
- [ ] Provider swap (Anthropic → OpenAI) via Settings → next tick uses the new credential.
- [ ] Cadence change → next tick respects new cadence.
- [ ] Existing-credential reuse path → no duplicate credential row created; `gateway_config.config_json.runners.manager.credential_alias` updated to point at the existing credential id.
- [ ] `agent_default_assignment` table is **not** written for the manager (verify by SQL inspection in test setup; checked at both workspace-creation time and credential-attach time).

## Cross-references

- Runtime-side design: [`parallel-agent-runtime/apps/orchestrator/docs/manager-agent.md`](../../../parallel-agent-runtime/apps/orchestrator/docs/manager-agent.md)
- The OQ-12 canonical decision: [`docs/open-questions/oq-12-git-and-source-control.md`](./open-questions/oq-12-git-and-source-control.md)
- Existing setup mechanics: `apps/api/src/services/setup.ts`, `apps/api/src/routes/setup.ts`
- Existing default-agent-credential application: `apps/api/src/services/default-agent-credentials.ts`
