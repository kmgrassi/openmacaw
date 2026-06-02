# Manager Agent — Runtime Design

Runtime-scoped design for `SymphonyElixir.Runner.Manager`.
Companion to the canonical decision in
`parallel-agent-platform/docs/open-questions/oq-12-git-and-source-control.md`.

This doc captures **how** to implement the manager agent in this
repo — module shape, scheduler, tools, system prompt, file
locations. The cloud-side platform pieces (event_log table,
webhook handler bumping `next_poll_at`, dashboard polling)
live on the platform side.

> **Status:** design-oriented. The default-login implementation
> sequence lives in
> [`manager-agent-default-login-pr-plan.md`](./manager-agent-default-login-pr-plan.md).

## What it is, in one paragraph

The manager agent is a **convergent reconciler** for tasks. On a
schedule (default every 5 minutes per work_item, configurable),
it reads the **current state** of every active task's artifact
(PR, Figma project, video render, etc.) and decides per task
what action to take next: dispatch an author, dispatch a
reviewer, merge a PR, escalate, or snooze. It is not driven by
streaming webhook events; webhooks only bump `next_poll_at` so
latency-sensitive cases (mentions, gate-greens) get fast-lane
attention without giving up the convergent-state benefits.

It is **just another runner kind** in this repo's existing
abstraction. Same `Runner` behavior. Same routing rules
(workspaces can pick which model runs their manager). Same
credential resolution. Same SDK. What's distinctive is its
prompt and its meta-toolset — tools that act *on* tasks rather
than *within* them.

## Module shape

`SymphonyElixir.Runner.Manager` lives at
`apps/orchestrator/lib/symphony_elixir/runner/manager.ex` —
alongside the existing `runner/{codex,planner,openclaw,
computer_use,mock}.ex` modules. Implements the same behavior
contract from `apps/orchestrator/lib/symphony_elixir/runner.ex`
(callbacks: `start_session/2`, `run_turn/3`, `stop_session/1`,
`ping/1`, `requires_workspace?/0`).

Wired into the runner enum at `runner.ex:99-105`:

```elixir
case runner_type do
  "codex"        -> SymphonyElixir.Runner.Codex
  "planner"      -> SymphonyElixir.Runner.Planner
  "manager"      -> SymphonyElixir.Runner.Manager      # NEW
  "openclaw"     -> SymphonyElixir.Runner.OpenClaw
  "computer_use" -> SymphonyElixir.Runner.ComputerUse
  "local_relay"  -> SymphonyElixir.Runner.LocalRelay   # OQ-02 PR 3
  _other         -> SymphonyElixir.Runner.Codex
end
```

`requires_workspace?/0` returns `false` — the manager doesn't
clone repos or hold per-task scratch space; it operates over
the artifact APIs.

### Stateless across ticks

Each `run_turn/3` call reconstructs context from the database.
The manager does not maintain a persistent conversation across
ticks — every tick is a fresh prompt with the current batch of
due work_items as input. Cheap, predictable token usage; easy
to reason about; survives orchestrator restarts trivially.

`start_session/2` returns a tiny session map: model config,
workspace_id, the resolved credential. `stop_session/1` is a
no-op.

## Configuration & bootstrap

The manager's model, provider, and credential are not hard-coded
in this module. They flow through the same routing-rule machinery
as every other runner ([OQ-03](../../../parallel-agent-platform/docs/open-questions/oq-03-routing-config-schema.md)):

```
manager scheduler tick
  └─ resolves dispatch via Routing.resolve(runner_kind: "manager", workspace_id)
       │
       ├─ matches the highest-priority routing_rule with runner_kind = "manager"
       │  for this workspace
       │
       └─ returns { runner_kind: "manager", model, credential_id }
            │
            └─ Credentials.resolve(credential_id, workspace_id)
                 │
                 └─ envelope-decrypts the credential, passes plaintext
                    only into the dispatched run_turn (then forgets it)
```

So **the manager respects the same routing override hierarchy as
any other runner**. A workspace admin who wants to swap the
manager from Anthropic Sonnet to OpenAI o-series just adds a
higher-priority routing rule with `runner_kind: "manager"` and a
different `model` / `credential_id`. No code change.

### Default seed for new workspaces

The workspace-level default lives in **`public.gateway_config`** —
the existing scope-keyed versioned config table (created in
`harper-server/supabase/migrations/20260227140000_create_gateway_config_tables.sql`,
extended with broker-sync columns in `20260303100200`). No new
table needed.

```
gateway_config row:
  scope_type  = 'workspace'
  scope_id    = <new workspace uuid>
  config_json = {
    "runners": {
      "manager": {
        "model":             "claude-sonnet-4",
        "credential_alias":  "default-anthropic",
        "min_cadence_ms":    60000
      }
    }
  }
```

This is the right home because:

- **Already there.** The table exists in prod with versioning,
  audit (`gateway_config_versions`), and apply-state
  (`gateway_config_state`) wired up.
- **Workspace-scoped by design.** `(scope_type, scope_id)` with
  `scope_type = 'workspace'` is the canonical workspace-config
  primitive in this codebase.
- **Same shape OQ-03 references** for hand-edited policy
  documents. OQ-03 also describes pulling per-rule overrides
  *out* of `gateway_config` into a relational `routing_rule`
  table — the manager's default belongs in `gateway_config` (a
  hand-edited policy doc), while any user-added higher-priority
  overrides go in `routing_rule` once that table lands (see
  *[Overriding the default](#overriding-the-default)* below).

### How bootstrap actually happens

**The manager exists for every workspace from the moment the
workspace is created — not from the moment the user clicks a
"set up" button.** This is a deliberate split between
*existence* and *activity*: the manager always exists; the
credential just turns it on.

Two distinct events drive the lifecycle:

#### Event A — Workspace creation (no user interaction required)

Triggered by whatever creates a `public.workspaces` row. The
platform's workspace-creation path performs three additional
inserts atomically with the workspace row:

1. An `agent` row with `type = 'manager'`, model defaulting to
   the recommended Sonnet config.
2. A `gateway_config` row keyed
   `(scope_type='workspace', scope_id=<workspace.id>)` with
   `config_json.runners.manager` populated (model,
   `credential_alias = null`, `min_cadence_ms = 60000`). Plus a
   `gateway_config_versions` row for history.
3. The orchestrator's workspace-created event handler starts a
   `Manager.Scheduler` GenServer under the workspace's
   supervision subtree.

**No credential is required for any of this.** The manager row,
the gateway_config row, and the GenServer are all created
without a credential reference. The scheduler ticks on cadence
but no-ops when no credential is configured (logs once,
maintains tick schedule, reports `idle: awaiting credential`
status).

#### Event B — Credential supplied by the user

Triggered by the existing `POST /api/setup` (or
`POST /api/default-agents/credentials` for the credential-only
flow) when the user pastes an API key. This call:

1. Inserts a `credential` row (envelope-encrypted).
2. Updates `gateway_config.config_json.runners.manager.credential_alias`
   to point at the new credential. Writes a new
   `gateway_config_versions` row.
3. Critically: **does NOT** insert an `agent_default_assignment`
   row for the manager — see *[The manager is NOT in
   `agent_default_assignment`](#the-manager-is-not-in-agent_default_assignment)*
   below. (Today's `createSetup` flow at
   `apps/api/src/services/setup.ts:514` calls
   `upsertDefaultAssignment(... role, "platform_bootstrap")` for
   `role ∈ {'planning','coding'}` — the manager path skips that
   call.)

The manager's `Scheduler` reads the new `gateway_config` payload
on its next tick (no restart needed) and starts dispatching real
work.

Background context on the existing platform mechanics:

- **`POST /api/setup`** (`apps/api/src/routes/setup.ts:78-92`)
  is today's per-agent setup endpoint, used for
  planning/coding. Backed by `createSetup` in
  `apps/api/src/services/setup.ts`.
- The response includes a `requirements.missing` field (per
  `contracts/setup.ts:140,148`, where `requirements:
  SetupRequirementStatusSchema` wraps a `missing` array) — the
  dashboard renders "you still need X" cards from this. The
  manager's `requirements.missing` will surface only the
  credential when that's the missing piece.

**The mechanics are platform-side; this doc captures only the
runtime contract.** See
[`parallel-agent-platform/docs/manager-agent-onboarding.md`](../../../parallel-agent-platform/docs/manager-agent-onboarding.md)
for the full UX flow, the workspace-creation extensions, and
the frontend.

### The runtime-side contract

1. **A `gateway_config` row exists** for the workspace with
   `config_json.runners.manager` set. The orchestrator reads
   this on every tick. If the row is missing (shouldn't happen
   post-workspace-creation, but defense in depth), fall back
   to `@manager_defaults` and log a warning.
2. **`config_json.runners.manager.credential_alias` may be
   `null`.** The scheduler must handle this gracefully: tick →
   detect missing credential → no-op → schedule next tick →
   report status as `idle: awaiting credential`. No errors,
   no exits, no retries — just inert ticking. When a credential
   is later wired in (Event B), the very next tick picks it
   up and starts real work.
3. **The `Manager.Scheduler` GenServer is started at workspace
   creation, not at credential-set.** Lifecycle is tied to the
   workspace, not to the credential. Started under the
   workspace's supervision subtree at workspace-created time;
   stopped (gracefully) at workspace-archived/deleted time.
   Idempotent — re-binding to an existing workspace is a no-op
   (orchestrator restart sweep walks all active workspaces and
   ensures a Scheduler is running for each).

### The manager is NOT in `agent_default_assignment`

`public.agent_default_assignment` is keyed on
`(workspace_id, user_id, role)` — it answers "what's THIS
user's default planning/coding agent in THIS workspace?". The
manager is workspace-singleton, not per-user (only one manager
runs per workspace, reconciling everyone's tasks). Adding
`role = 'manager'` to that table would force a per-user
discriminator that has no semantic meaning and creates ambiguity
("alice's manager vs bob's manager?" — there's only one).

The `gateway_config` row is the sole source of truth for the
manager's default config. The `agent` row created by the
**workspace-creation hook** (Event A above — not by
`createSetup`, which is only invoked for planning/coding
agents) represents the manager-the-LLM-config (model,
provider) and is referenced from the credential resolution
path; the assignment-style mapping just doesn't exist for it.

### Resolution at runtime

```elixir
# Inside the Scheduler GenServer's tick:
config = GatewayConfig.fetch_workspace(workspace_id)
manager = get_in(config, ["runners", "manager"]) || @manager_defaults

# OQ-03 routing_rule overrides (when the table lands):
case Routing.resolve(runner_kind: "manager", workspace_id: workspace_id) do
  {:ok, override} -> override          # user-added higher-priority rule wins
  :no_match       -> manager           # fall back to the gateway_config default
end
```

`@manager_defaults` is a code-level fallback (Sonnet at 60s
cadence) so the manager is robust against a workspace whose
`gateway_config` row was somehow not seeded — log a warning and
continue. Defense in depth.

### Why Claude Sonnet as the recommended default

The manager runs **continuously** (every `min_cadence_ms`), not
in response to a user prompt. So the cost trade-off is different
from author/reviewer agents:

- Each tick is one `run_turn` covering a *batch* of due work_items
  (not one per task), so per-tick token usage is bounded but
  scales modestly with the workspace's active task count.
- Frequency is high: ~1,440 ticks/day at the 60s `min_cadence`
  default. Cost-conscious workspaces should keep `min_cadence`
  closer to 5–10 minutes; latency-sensitive ones (heavy
  `@-mention` use) drop to 10s.
- Quality matters: a manager that misroutes or over-escalates
  costs the user time. We're pricing this against good judgment
  on tool calls, not raw output token count.

Sonnet hits the sweet spot in our experience — strong on
structured tool calls, cheap enough to run continuously,
provider already required for most workspaces. We document the
choice as a recommendation, not a hard requirement.

### Overriding the default

Two override paths, in order of precedence (highest wins):

1. **Per-priority routing rule** ([OQ-03](../../../parallel-agent-platform/docs/open-questions/oq-03-routing-config-schema.md)
   — `routing_rule` table). Wins over the workspace default.
   This is what users edit in the future routing-rules UI.
2. **`gateway_config` workspace default**. The seed above; what
   the dashboard's "Workspace settings" page edits directly.
3. **Code-level fallback** (Sonnet, 60s cadence). Last resort if
   neither of the above is set; logs a warning.

Examples of overrides a workspace might add:

| Use case | Override |
|---|---|
| "We've already paid for an OpenAI subscription" | `model: gpt-5`, `credential: <openai>` |
| "Run the manager on our local llama server" | `runner_kind: "local_relay"` (different runner kind), `model: openai_compatible` (downstream within the daemon) |
| "Cheaper model — internal team only" | `model: claude-haiku-4` |
| "Different model for video-vertical workspaces" | per-task-kind override via `match.task_kind` |

The default rule has `priority = 0`, so any added rule wins.

### Lifecycle

| Event | What happens |
|---|---|
| Workspace created | Bootstrap seeds default routing rule + starts `Scheduler` GenServer (under supervision tree). |
| Orchestrator restarts | Supervision tree starts a `Scheduler` for every active workspace. Each begins ticking on the configured cadence. |
| Workspace archived / deleted | `Scheduler` is gracefully stopped via the supervisor. Outstanding ticks complete and exit. |
| Default routing rule edited via dashboard | Next tick reads the new rule (no restart needed). |
| Credential rotated | Next tick resolves the new credential (the router calls `Credentials.resolve/2` on every tick, not at session start). |
| `min_cadence_ms` changed | Takes effect on the next tick after the GenServer's state is reloaded (config-reload is a hot path; doesn't restart the GenServer). |

### What the manager does NOT need configured

- **Repo access.** Manager doesn't clone or read repos; it operates over artifact APIs (GitHub, Figma, etc.) read by per-vertical adapters.
- **Per-task model overrides.** Per-task overrides target *author* or *reviewer* dispatches, not the manager itself. The manager's own model is fixed by its workspace-level rule and reads consistently regardless of what task it's making decisions about.
- **A workspace-level kill switch.** If a workspace wants the manager off, set `min_cadence_ms` very high (e.g., 1 day) or revoke the credential. We deliberately don't add a "manager_enabled" boolean — kill-switching is a credential / cadence concern, and a separate boolean would drift out of sync with reality.

## Scheduler

A new GenServer at
`apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex` —
one per workspace, supervised under the existing top-level
supervision tree (alongside `WorkflowStore`, `StatusDashboard`,
etc.).

Tick loop (rough Elixir):

```elixir
def handle_info(:tick, state) do
  # Each `where` clause is implicitly AND'd. Keeping them separate
  # is the clearest way to make the workspace + state filters
  # mandatory regardless of how the next_poll_at predicate evolves
  # (vs combining everything into one clause where `or` precedence
  # could let an overdue task bypass the workspace filter).
  due_work_items =
    Repo.all(
      from wi in WorkItem,
        where: wi.workspace_id == ^state.workspace_id,
        where: wi.state in [:running, :awaiting_review],
        where: is_nil(wi.next_poll_at) or wi.next_poll_at <= ^now(),
        order_by: [asc: wi.next_poll_at]
    )

  if due_work_items != [] do
    Manager.run_batch(state.session, due_work_items)
  end

  Process.send_after(self(), :tick, state.min_cadence_ms)
  {:noreply, state}
end
```

Defaults:
- `min_cadence_ms` = 60_000 (60s tick floor — the scheduler wakes
  at most this often).
- Per-work-item `poll_cadence_seconds` = 300 (a non-bumped task
  gets checked every 5 minutes).

Both are configurable per workspace via `gateway_config`
([OQ-03](../../../parallel-agent-platform/docs/open-questions/oq-03-routing-config-schema.md)).

### How webhooks influence the schedule

When the platform's webhook handler classifies an event as
"interesting" (review submitted, check_run completed, mention
matched), it sets `work_item.next_poll_at = now()`. The manager's
scheduler picks it up on the next tick. **The webhook handler
never invokes the manager directly** — it only bumps the timer.

This is the layered architecture from OQ-12 §"How event handling
actually works":

| Layer | What | Where |
|---|---|---|
| 1 | Wake-up signals (deterministic, no LLM) | platform `apps/api/src/routes/work-items.ts` |
| 2 | Manager-agent reconciler (LLM, 1 turn per cadence) | this repo, `Runner.Manager` |
| 3 | Author/reviewer/etc. runners (LLM, only when manager dispatches) | this repo, existing runners |

## Toolset

Manager tools are resolved through `SymphonyElixir.ToolRegistry` from
the `:manager` bundle. GitHub and repository inspection goes through
the read-only `git.run` tool instead of bespoke GitHub artifact tools.

| Tool | Purpose |
|---|---|
| `list_plans` | Reads workspace-scoped plans. |
| `list_work_items` | Reads workspace-scoped work items. |
| `dispatch_runner(work_item_id, runner_kind, intent, context)` | Spawns an author / reviewer / mentioned-bot turn. |
| `escalate_to_human(work_item_id, …)` | Same tool from [OQ-06](../../../parallel-agent-platform/docs/open-questions/oq-06-escalation-policy-schema.md). Manager-emitted escalations capture what *the manager* observed, not the author. |
| `snooze(work_item_id, seconds)` | "Nothing to do; check again in N seconds." Updates `next_poll_at`. |
| `mark_done(work_item_id)` | Closes the task (work delivered, PR merged, etc.). |
| `git.run(command)` | Runs read-only `git` / `gh` inspection commands in the workspace. |
| `scheduled_task.*` | Creates, reads, updates, lists, and deletes scheduled tasks. |

Each tool spec has the `inputSchema` field shape used by the
existing planner tools (verified at `database_tools.ex:96, 112,
130, 264`). Function-call schema validation via the same Ajv-
equivalent pattern as `create_plan` from
[OQ-01](../../../parallel-agent-platform/docs/open-questions/oq-01-plan-format.md).

## What the manager sees on each tick

Same shape regardless of source — a webhook event, a manual user
action, an MCP elicitation response all get normalized to
work item summaries and metadata before the manager decides whether to
inspect more context with `list_*` or `git.run`.

Input to one `run_turn/3`:

```jsonc
{
  "system": "<manager system prompt>",
  "workspace": { /* workspace context */ },
  "due_tasks": [
    {
      "work_item_id": "...",
      "title": "Clean up unused imports in src/components/",
      "current_state_summary": "PR #142 open, 1 review (request_changes from alice), 2 line-comments, lint green, tests green, last commit 18m ago",
      "last_polled_at": "2026-04-25T15:55:00Z",
      "events_since_last_poll": [
        { "kind": "pull_request_review.submitted", "summary": "alice: request_changes — see comments" },
        { "kind": "pull_request_review_comment.created", "count": 2 }
      ]
    }
    // up to N more tasks in this batch
  ],
  "tools": ["list_plans", "list_work_items", "dispatch_runner",
            "escalate_to_human", "snooze", "mark_done", "git.run"]
}
```

The manager does **not** see full event payloads upfront. If it needs
detail, it uses scoped workspace reads or read-only GitHub inspection
through `git.run`. This keeps the manager's input small and predictable
in cost regardless of how chatty a PR has been.

## System prompt

Lives in
`apps/orchestrator/priv/prompts/manager-system-v1.md`,
versioned the same way as the escalation guidance in
[OQ-06](../../../parallel-agent-platform/docs/open-questions/oq-06-escalation-policy-schema.md)
and the planner system prompt.

Sketch (real prompt firms up during implementation; this is the
shape):

> You are a manager agent responsible for moving tasks forward in
> a workspace. For each task in `due_tasks`, decide the
> **smallest next action** that brings it closer to done.
>
> Common patterns:
> - All gates green and the next step is to land the change → call
>   `dispatch_runner` with `intent: "land_change"`.
> - A reviewer requested changes → call `dispatch_runner` with `intent: "address_review"`.
> - Multiple line-comments since last poll → one `dispatch_runner` covering all of them, not per-comment.
> - No progress for K consecutive polls → call `escalate_to_human` (default K=4).
> - Nothing to do right now → call `snooze` with a sensible interval.
>
> Use `git.run` for narrow read-only repository or GitHub inspection
> when the current state summary is genuinely insufficient.
>
> Always make exactly one tool call per task in `due_tasks`.

## Idempotency and convergence

The manager is a convergent reconciler — K8s-controller style.
Two important invariants:

- **Idempotent.** Running the same tick twice on the same state
  produces the same decisions. The manager's tool calls are
  themselves idempotent: `dispatch_runner` for an intent already
  in flight short-circuits, and `mark_done` can be repeated for
  a completed work item.
- **Self-healing.** A missed webhook is harmless — the next
  scheduled tick reads the current state and catches up. We do
  NOT need elaborate webhook re-delivery guarantees.

Implementation notes:

- `dispatch_runner` checks for an in-flight runner of the same
  `runner_kind + intent` for that work_item before spawning. In-
  flight is tracked via `runner_session.work_item_id`.
- `mark_done` is idempotent — `update work_item set state =
  'done'` is a no-op if already `done`.

## Escalation paths from the manager

The manager has `escalate_to_human` in its toolset. Two places
it triggers:

1. **Stuck task detection.** If a work_item has had no progress
   in K consecutive polls (default K=4 → 20 minutes default),
   the manager calls `escalate_to_human` with
   `reason_kind: "stuck_after_retries"`.
2. **Resource caps hit.** Per-task cost / turn / wallclock caps
   from [OQ-06](../../../parallel-agent-platform/docs/open-questions/oq-06-escalation-policy-schema.md)
   are evaluated by the manager (it has the visibility). When
   hit, escalate.

The author/reviewer agents also have `escalate_to_human` for
self-flagged escalation (OQ-06's tool-call pattern). The manager
escalates from **observation**; the author escalates from
**self-doubt**. Different angles on the same problem.

## File layout summary

```
apps/orchestrator/
├── lib/symphony_elixir/
│   ├── runner.ex                              add "manager" to enum
│   ├── runner/manager.ex                      Runner behavior implementation
│   └── manager/
│       ├── scheduler.ex                       per-workspace GenServer
│       ├── tools.ex                           tool_specs/0 + execute/3 for the 8 tools
│       └── artifact_state/
│           ├── github.ex                      v1 — read PR state via GitHub API
│           ├── davinci.ex                     deferred — video render queue
│           └── figma.ex                       deferred — Figma project state
├── priv/prompts/
│   └── manager-system-v1.md                   versioned system prompt
└── test/symphony_elixir/runner/
    └── manager_test.exs                       behavior conformance + tick loop
```

## Cross-references

- Canonical decision: [`parallel-agent-platform/docs/open-questions/oq-12-git-and-source-control.md`](../../../parallel-agent-platform/docs/open-questions/oq-12-git-and-source-control.md), §"Decision (2026-04-25, revised): manager-agent reconciler" through §"Cost and latency"
- The `Runner` behavior contract this implements: [`apps/orchestrator/lib/symphony_elixir/runner.ex`](../lib/symphony_elixir/runner.ex) lines 54-89
- Existing reference runners alongside this one: [`apps/orchestrator/lib/symphony_elixir/runner/`](../lib/symphony_elixir/runner/) (`codex.ex`, `planner.ex`, `openclaw.ex`, `computer_use.ex`, `mock.ex`)
- Existing workspace-config table the manager defaults live in: `harper-server/supabase/migrations/20260227140000_create_gateway_config_tables.sql` (`public.gateway_config`)
- Existing workspace-scope precedent the bootstrap follows: `harper-server/supabase/migrations/20260425120000_create_agent_default_assignment.sql` (per-user planning/coding defaults; the manager is workspace-scoped, not per-user, so the row lives in `gateway_config` instead, and the manager is NOT inserted into `agent_default_assignment`)
- Existing platform setup endpoints touched by the manager:
  - `POST /api/setup` (`parallel-agent-platform/apps/api/src/routes/setup.ts:78-92` → `createSetup`)
  - `POST /api/default-agents/credentials` (`apps/api/src/routes/setup.ts:63-64` → `applyDefaultAgentCredentials`) — the credential-only flow
- Platform-side companion doc covers UX + API contract: [`parallel-agent-platform/docs/manager-agent-onboarding.md`](../../../parallel-agent-platform/docs/manager-agent-onboarding.md)
- The platform-side webhook handler this manager pairs with: `parallel-agent-platform/apps/api/src/routes/work-items.ts`
- Escalation tool the manager invokes: [`OQ-06`](../../../parallel-agent-platform/docs/open-questions/oq-06-escalation-policy-schema.md)
- Auto-merge policy the manager respects: [`OQ-07`](../../../parallel-agent-platform/docs/open-questions/oq-07-auto-merge-gate-selection.md)

## Out of scope for this doc

- Per-PR (sequenced) implementation plan. This doc is design
  only; the PR breakdown is a separate doc TBD (would mirror the
  shape of `apps/orchestrator/docs/oq-01-create-plan-tool-pr-plan.md`).
- Platform-side migrations (`event_log` table, `next_poll_at`
  column on `work_items`, `mention_handler` table) — those live
  in `harper-server`. See OQ-12 §"Build sequence" for the full
  cross-repo work.
- Dashboard surface (e.g., a "Manager activity" view showing
  recent decisions). UI is on the platform side.
