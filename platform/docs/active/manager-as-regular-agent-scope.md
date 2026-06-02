# Manager as a Regular Agent — Scope

## Goal

Stop treating manager agents as a separate runtime + platform surface.
The user's framing: _"all a manager agent is, is the same agent as
planning or any other agent, but we have the ability to pass in
messages in a cron job or a sequential way."_

After this refactor:

- A manager agent's model / provider / credential resolution uses the
  **same execution profile resolver** as any other agent. No
  `Manager.SessionResolver`, no `runners.manager` block in gateway_config,
  no manager-only `@supported_providers` list.
- A manager agent runs through the **same runner module** as any other
  llm_tool_runner agent. No `Runner.Manager`.
- The **scheduler** stays — that's the only genuinely manager-only thing.
  It uses the already-merged `ChatGateway` to inject messages into the
  same chat pipeline a websocket session uses.

## What [PR #320](https://github.com/kmgrassi/parallel-agent-runtime/pull/320) already did

[runtime#320](https://github.com/kmgrassi/parallel-agent-runtime/pull/320)
(merged 2026-05-13) collapsed the message-injection path. Before #320 the
manager had its own batch coordinator (`Manager.run_batch/3`), its own
recorder (`Manager.MessageRecorder`), and its own tests. After #320:

- New module `apps/orchestrator/lib/symphony_elixir/chat_gateway.ex`
  (+412 lines) is the _single_ entrypoint for "post a message to an
  agent and start a run." Used by both the websocket session and the
  manager scheduler.
- `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex:23,163,416,423`
  now calls `ChatGateway.post_message/3` instead of going through a
  manager-specific batch path.
- Deleted: `manager.ex` (−190), `manager/message_recorder.ex` (−340),
  `manager_test.exs` (−290), `message_recorder_test.exs` (−255).

So the "treat scheduler-driven runs and chat-driven runs the same"
part is **already done**. This scope picks up the remaining duplications.

## Remaining duplications

Every ref below is repo-root relative and verified against the current
state of `main` (post-#320).

### Runtime (`parallel-agent-runtime`)

**`apps/orchestrator/lib/symphony_elixir/manager/session_resolver.ex`** (418 lines)

- Reads `runners.manager` from workspace-scoped `gateway_config`.
- Implements its own provider allowlist (`@supported_providers` on
  line 16 — the source of today's openai_codex drift incident, see
  PR #321).
- Resolves credentials by re-querying `agent_inventory`.
- Returns manager-specific idle reasons (`:manager_config_missing`,
  `:manager_credential_missing`, `:manager_provider_unsupported`).

What it replicates: `Gateway.AgentExecutionProfile.resolve/2` (the
generic execution profile resolver that reads `routing_rule`). The data
source differs (workspace gateway_config vs agent routing_rule), but
the work — provider validation, credential lookup, api_key extraction —
is the same.

**`apps/orchestrator/lib/symphony_elixir/runner/manager.ex`** (~300 lines)

- Runner implementation for managers.
- Manager-specific elements: tool bundle is `ToolRegistry.bundle(:manager)`,
  fetches message history via `Manager.MessageHistory`.
- Everything else (start_session, run_turn, stop_session, model loop)
  is the same shape as any other runner.

What it replicates: the generic runner behavior. The only manager-only
bit is which tool bundle to load — already a configurable concern.

**`apps/orchestrator/lib/symphony_elixir/manager/message_history.ex`** (141 lines)

- Fetches prior messages for replay into the model request.
- Filters by agent_id + workspace, excludes current run, text-only.

What it replicates: generic message history. Every agent needs this;
managers happen to have a typed version.

### Platform (`parallel-agent-platform`)

**The dual-write to `gateway_config.runners.manager`**

- `apps/api/src/services/stored-agent-routing.ts:163-207` —
  `managerWorkspaceConfig` builds the workspace-scoped `runners.manager`
  block.
- `apps/api/src/services/stored-agent-routing.ts:209-264` —
  `persistWorkspaceManagerGatewayConfig` does the write.
- Called from `apps/api/src/services/stored-agent-routing.ts:110-119`,
  `:149-158`, `:338-346` — every credential/model sync helper, plus
  `ensureStoredAgentDefaultRouting`.
- Also called from `apps/api/src/services/agent-runtime-profile.ts:289-305`
  when the user updates a manager's runtime profile.

The runtime side (`Manager.SessionResolver`) reads this. If the runtime
moves to the generic resolver, every one of these writes becomes
unnecessary.

**Manager-only platform routes**

- `apps/api/src/routes/manager-agent.ts` (~400 lines):
  - `GET/PUT /api/manager-agent/agents/:agentId/config` — scheduler config
    (cadence, due-task query). Truly scheduler-only.
  - `POST /api/manager-agent/activate` — credential + model setup. **A
    reskin of `PUT /api/agents/:agentId/runtime-profile`** with manager-
    specific validation.
  - `GET /api/runtime/manager-status` — polls scheduler health. Could be
    generic `GET /api/runtime/agent/:id/status` once non-manager agents
    can be scheduled.
- `apps/api/src/services/manager-agent-config.ts` (288 lines) — read/write
  the scheduler config. Real scheduler-only logic, but the storage
  (workspace gateway_config) is the same dual-write problem.
- `apps/api/src/services/manager-runtime-status.ts` (~100 lines) — wraps
  a runtime HTTP call. Generic wrapper, not manager-specific behavior.

**Manager-only platform special-casing**

- `contracts/provider-registry.ts:177` — `MANAGER_PROVIDER_IDS`
  (2 entries). Today gates which providers the manager activation
  endpoint accepts. After consolidation, manager is just an agent —
  the generic execution-profile policy matrix from
  [unified-execution-profile-scope.md](unified-execution-profile-scope.md)
  covers it.
- `apps/api/src/services/agent-runtime-profile.ts:34-42, 44-51` —
  `isCredentiallessManagerProfile` exempts manager + llm_tool_runner +
  openai_compatible from credential checks. Should be generic
  "credential required = false when runnerKind is local-relay-style."

## Proposed architecture

```
Today (post-#320):                           Proposed:
─────────────────                            ─────────

ChatGateway.post_message                     ChatGateway.post_message
   ├─ websocket session ───────┐                ├─ websocket session ───┐
   └─ Manager.Scheduler ────┐  │                └─ AgentScheduler ──┐   │
                            ▼  ▼                                    ▼   ▼
                       Runner.Manager                          Runner (generic)
                            │                                        │
                            ▼                                        ▼
                   Manager.SessionResolver               AgentExecutionProfile.resolve
                   (reads workspace gateway_config)      (reads routing_rule)
                            │                                        │
                            ▼                                        ▼
                   runners.manager.* fields              routing_rule.{provider,model,...}
```

The scheduler stays. Everything else collapses.

## Phases

Each phase is independently shippable and doesn't break running
managers.

### Phase 1 — Stop reading workspace gateway_config in the resolver (runtime PR)

Repo: `parallel-agent-runtime`.

- Change `Manager.SessionResolver.resolve/3` to call
  `Gateway.AgentExecutionProfile.resolve(agent_id, workspace_id)` for
  provider/model/credential resolution. Keep manager-specific idle
  reasons as a translation layer for now.
- Read `min_cadence_ms` and `due_task_query` from a new
  `manager_scheduler_config` row keyed on agent_id (or, transitionally,
  from `runners.manager` for those two fields only).
- Update tests that mock workspace gateway_config to instead mock
  routing_rule.

After this, the scheduler still works, but the resolver reads from the
canonical routing-rule source. Workspace gateway_config writes from the
platform become non-load-bearing.

### Phase 2 — Stop dual-writing on the platform (platform PR)

Repo: `parallel-agent-platform`.

- Delete `persistWorkspaceManagerGatewayConfig` and its callers in
  `stored-agent-routing.ts`.
- Delete the manager branch in `agent-runtime-profile.ts:289-305`.
- The manager-config route (`PUT /api/manager-agent/agents/:agentId/config`)
  still writes cadence/due-task-query, but now to whatever store Phase 1
  picked.

### Phase 3 — Collapse `Manager.SessionResolver` into the generic resolver (runtime PR)

Repo: `parallel-agent-runtime`.

- Delete `Manager.SessionResolver`. The scheduler calls
  `Gateway.AgentExecutionProfile.resolve/2` directly and uses the same
  error vocabulary as the generic resolver.
- Move the manager-specific cadence/due-task-query read to a small
  `Manager.SchedulerConfig` module (the only field set that's genuinely
  scheduler-only).
- Update platform-side idle-reason rendering to use the generic
  reasons (`:config_missing`, `:credential_missing`,
  `:provider_unsupported`) instead of the manager-prefixed ones.

### Phase 4 — Collapse `Runner.Manager` into the generic runner (runtime PR)

Repo: `parallel-agent-runtime`.

- Delete `Runner.Manager`. Use the generic runner module (or a single
  `Runner.LlmToolRunner` if that lives elsewhere).
- Tool bundle is selected by `agent.type` ("manager" → manager tools,
  "planning" → planning tools, etc.) via the existing tool registry.
- Message history is generic — rename `Manager.MessageHistory` to
  drop the manager prefix.

### Phase 5 — Collapse platform routes (platform PR)

Repo: `parallel-agent-platform`.

- Delete `POST /api/manager-agent/activate`. The web UI uses
  `PUT /api/agents/:agentId/runtime-profile` like every other agent.
- Keep the manager-config route (it's the scheduler's config), but
  rename to `/api/agents/:agentId/scheduler-config` to make the
  intent clear and to support future non-manager scheduled agents.
- Delete `MANAGER_PROVIDER_IDS`; manager allowlist comes from the
  policy matrix in
  [unified-execution-profile-scope.md](unified-execution-profile-scope.md).
- Web UI: `ManagerAgentSection` becomes "scheduler config for any agent
  with `scheduled: true`."

### Phase 6 — Rename the leftover manager directory (runtime PR)

Repo: `parallel-agent-runtime`.

- Rename `manager/scheduler.ex` → `scheduler/agent_scheduler.ex`.
- Rename `manager/bootstrapper.ex` → `scheduler/bootstrapper.ex`.
- Rename `manager/supervisor.ex` → `scheduler/supervisor.ex`.
- Runtime-owned manager business logic can stay under `manager/`, but
  platform defaults should grant only the current catalog tools, not
  deprecated manager-specific artifact tools.

After this, `manager/` only contains manager-specific business logic —
the runtime-architectural manager-ness is gone.

## What stays manager-only (and rightly so)

These are real manager-only concerns, not duplications. They survive
the refactor:

- **The scheduler.** Polling on a cadence, due-task discovery, batch
  coordination.
- **Manager business logic.** Work-item polling, artifact-state tracking,
  and PR lifecycle decisions are manager-specific, but platform tool grants
  should come from the current catalog bundle rather than old manager-only
  tool names.
- **Manager's system prompt.** `manager/prompt.ex` (50 lines). Loads
  the manager-specific instructions. Every agent has a prompt; the
  manager's is unique.
- **Manager artifact state tracking** (`manager/artifact_state/`).
  Tracking GitHub PR state across runs is manager work.

The line is: _scheduling_ is a generic capability that today only
managers have. _What a manager does once it's running_ (which tools,
which prompt, which work items) is genuinely manager-specific.

## Where the scheduler config goes — resolved

The harper-server table `agent_heartbeat_config` already exists and
maps cleanly to what the scheduler needs. Created in
[20260302061200_create_agent_heartbeat_config.sql](https://github.com/harper-hq/harper-server/blob/main/supabase/migrations/20260302061200_create_agent_heartbeat_config.sql)
as "a DB-backed replacement for HEARTBEAT.md source-of-truth."

| Today (`gateway_config.runners.manager`) | Tomorrow (`agent_heartbeat_config`)                |
| ---------------------------------------- | -------------------------------------------------- |
| `min_cadence_ms`                         | `policy_json.cadence_ms`                           |
| `due_task_query`                         | `tasks_json: [{ kind: "due_work_items", filter }]` |
| (the inferred "run now" message)         | `heartbeat_prompt`                                 |
| (scheduler implicit on/off)              | `enabled` (already a column)                       |
| —                                        | `quiet_hours_json` (bonus we don't have today)     |

The `tasks_json` envelope is locked in below ("Schedule-any-agent — in
scope"); `policy_json` only holds generic scheduler fields like cadence
and optional retry policy. `due_task_query` is not duplicated there.

Properties that make it a fit:

- `unique (workspace_id, agent_id)` — same key the scheduler keys on
- Already in production schema; **zero references in platform or
  runtime code** (only generated types + the migration that created it),
  so reusing it doesn't conflict with any consumer
- No `runners.manager`-specific shape, so the scheduler config stops
  being "manager only" by data model — any future scheduled agent
  type fits

Phase 1 reads from this table instead of inventing a new one. The
`agent_heartbeat_config` migration may need a small follow-up (drop the
`'main'` defaults on `workspace_id` / `agent_id` which are text rather
than uuid in this older migration), but the table itself is reusable
as-is for the scheduler's read path.

## Schedule-any-agent — in scope

The original framing — _"the same agent as planning or any other
agent, but with the ability to pass in messages in a cron job"_ —
applies to any agent type. A planning agent that wakes hourly to
review the backlog. A coding agent that polls a label every 15
minutes. Whatever. Scheduling is a _generic capability_, not a
manager attribute.

Locks in the storage contract so future scheduled non-manager agents
fit without a migration:

```jsonc
// agent_heartbeat_config.tasks_json
[
  {
    "kind": "due_work_items",        // first registered kind
    "filter": { "states": [...], "plan_ids": [...] }
  }
  // future kinds: "linear_label_poll", "github_pr_review_queue", etc.
]
```

`agent_heartbeat_config.policy_json` holds genuinely generic fields:
`cadence_ms`, optional `quiet_hours` overrides, retry policy. The
manager's `due_task_query` becomes the first registered task kind
(`due_work_items`); other scheduled-agent kinds register their own
trigger shapes without touching the table.

The platform doesn't need to expose scheduling for non-manager agents
_today_ — the UI can keep showing scheduler config only on manager
agents until there's a concrete use case for another type. The data
model just stays generic so that addition is a UI change, not a
schema change.

## Boundary: scheduler config vs scheduled tasks

`agent_heartbeat_config` is the home for an agent's scheduler policy:
whether the agent wakes up, how often it wakes up, quiet hours, retry
policy, heartbeat prompt, and registered task-kind filters such as
`due_work_items`.

It is **not** the home for individual user-created recurring instructions.
Concrete schedules like "check Hacker News every Monday at 10am" belong in
the existing `scheduled_task` model, with occurrence history in
`scheduled_task_run`. Those rows deliver free-text instructions as
`scheduled_agent_message` through `ChatGateway`.

The two models should compose:

- `agent_heartbeat_config` answers "can/when should this agent wake and what
  scheduler task kinds are enabled?"
- `scheduled_task` answers "what specific recurring instruction should be
  delivered, to which agent, at what next run time?"

This keeps manager due-work polling, future scheduled non-manager heartbeat
policies, and user-authored recurring agent messages from collapsing into one
JSON envelope.

## Phases that change

Phases 1–4 are unchanged (they consolidate the manager-specific
runtime path; that's still the priority). Two phases get re-scoped:

### Phase 5 — Collapse platform routes + generalize scheduler-config endpoint

Repo: `parallel-agent-platform`. (Was already in the plan; renaming
to reflect generic.)

- Delete `POST /api/manager-agent/activate`. Web UI uses
  `PUT /api/agents/:agentId/runtime-profile` like every other agent.
- Rename the scheduler-config route from
  `/api/manager-agent/agents/:agentId/config` to
  **`/api/agents/:agentId/scheduler-config`**. Body contract uses the
  generic `tasks_json: [{ kind, filter }]` envelope. The web UI
  initially calls this only for manager agents; other agent types can
  consume the same endpoint once the UI is ready.
- Delete `MANAGER_PROVIDER_IDS`; manager allowlist comes from the
  unified execution-profile policy matrix
  ([#437](https://github.com/kmgrassi/parallel-agent-platform/pull/437)).
- Web `ManagerAgentSection` becomes a thin manager-specific wrapper
  over a generic `SchedulerConfigEditor` component. The wrapper picks
  the `due_work_items` task kind by default; future agent types add
  their own wrappers (or the user fills out a generic form).

### Phase 6 — Rename runtime modules out of `manager/`

Repo: `parallel-agent-runtime`. (Unchanged in intent, but the names
should reflect that scheduling is generic.)

- `manager/scheduler.ex` → `scheduler/agent_scheduler.ex`
- `manager/bootstrapper.ex` → `scheduler/bootstrapper.ex` — discovers
  any agent with an enabled `agent_heartbeat_config` row, not just
  managers
- `manager/supervisor.ex` → `scheduler/supervisor.ex`
- The `manager/tools/` directory and `manager/tool_support.ex` stay
  under `manager/` because those _are_ manager-specific.

### New Phase 7 — Per-agent-type scheduler UI (follow-up)

Repo: `parallel-agent-platform`. (Out of the consolidation critical
path. Tracks the actual product work of letting users schedule a
planning agent / coding agent.)

- Add `scheduled: true` toggle to the generic agent settings.
- Render `SchedulerConfigEditor` for any agent with the flag enabled.
- Define a registry of task-kind editors so each agent type can ship
  its own filter UI (manager → due-work-items filter; planning → some
  TBD trigger; coding → ditto).
- This is a product decision per agent type, not a refactor — keep it
  off the critical path of the consolidation work.

## Open questions

- **Task-kind registration boundary.** When a new task kind is added
  (e.g., `linear_label_poll`), where does the schema for its `filter`
  live? Options: (a) JSON schema files registered in
  `contracts/scheduler-task-kinds/`; (b) Zod schemas alongside the
  existing contracts; (c) only the runtime knows the shape, platform
  passes-through. (b) keeps validation at the API boundary; pick
  before Phase 5 lands.

- **Manager idle-reason API contract.** Today the platform shows
  `:manager_provider_unsupported` etc. in the manager status panel. If
  Phase 3 collapses to generic reasons, the web UI needs updates and
  any external consumers of the status endpoint need to be checked.
- **Per-PR provider drift.** The same source-of-truth audit that
  surfaced this work (see
  [unified-execution-profile-scope.md](unified-execution-profile-scope.md))
  found that `Manager.SessionResolver.@supported_providers` drifts from
  `MANAGER_PROVIDER_IDS` (e.g., it doesn't include `openai_codex`).
  After Phase 3 the manager allowlist disappears; the generic
  `KNOWN_EXECUTION_PROVIDER_IDS` is the only list, gated by the
  cross-repo CI check in
  [PR #439](https://github.com/kmgrassi/parallel-agent-platform/pull/439).

## Out of scope

- The scheduler itself. This doc keeps it as-is (post-#320 already
  routes it through `ChatGateway`).
- Manager tool implementations (`snooze.ex` etc.). They stay where
  they are.
- Work item / plan business logic.
- Building a real ChatGPT-OAuth manager transport. Currently rejected
  (see runtime PR #321); orthogonal to this consolidation.

## Success criteria

- A manager agent's credential + model are configured the same way as
  a planning agent's: same UI, same endpoint, same routing-rule row.
- `Manager.SessionResolver`, `Runner.Manager`,
  `persistWorkspaceManagerGatewayConfig`, `MANAGER_PROVIDER_IDS`, and
  the special branch in `agent-runtime-profile.ts:289-305` no longer
  exist.
- The only files under `manager/` in the runtime are manager
  business-logic tools and the manager system prompt. The scheduler
  has moved out.
- Adding a new manager-eligible provider requires editing the same
  files as adding a non-manager-eligible provider (i.e., none — it
  goes through the unified execution-profile policy).
- **Scheduling is a generic capability.** Adding a scheduled
  non-manager agent (e.g., a planning agent that wakes hourly) is a
  UI + task-kind addition, not a schema change. The data model
  (`agent_heartbeat_config` + `tasks_json: [{ kind, filter }]`)
  doesn't need to know which agent types are eligible.
