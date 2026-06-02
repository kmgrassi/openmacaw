# Manager as a Regular Agent - Runtime Scope

Repo: `parallel-agent-runtime` (this repo).

Companion platform scope:
[parallel-agent-platform#440](https://github.com/kmgrassi/parallel-agent-platform/pull/440),
`docs/active/manager-as-regular-agent-scope.md`.

Related sibling planning work:

- [parallel-agent-platform#437](https://github.com/kmgrassi/parallel-agent-platform/pull/437)
  - merged.
- [parallel-agent-platform#438](https://github.com/kmgrassi/parallel-agent-platform/pull/438)
  - open.
- [parallel-agent-platform#439](https://github.com/kmgrassi/parallel-agent-platform/pull/439)
  - open.

## Goal

Make the manager a normal scheduled agent in the runtime.

The manager should keep the things that are actually manager-specific:
scheduling, due-work polling, manager prompt, manager tools, and manager
artifact state. It should stop owning separate runtime architecture for
provider/model/credential resolution, chat dispatch, runner selection, and
message history.

After this refactor:

- Manager provider/model/credential resolution uses
  `SymphonyElixir.Gateway.AgentExecutionProfile.resolve/2`, the same
  routing-rule resolver used by normal chat dispatch.
- The manager scheduler injects messages into `ChatGateway` and no longer
  depends on `runners.manager` for model/runtime profile data.
- `Runner.Manager` is collapsed into the generic llm-tool-runner path, with
  manager-specific prompt and tool selection passed as data.
- Scheduler cadence and due-task-query live in a scheduler-owned store instead
  of the old workspace `gateway_config.runners.manager` block.

## What #320 already did

[runtime#320](https://github.com/kmgrassi/parallel-agent-runtime/pull/320)
merged the important message-injection unification on 2026-05-13.

Before #320, the manager had its own batch coordinator and message recorder.
After #320:

- `apps/orchestrator/lib/symphony_elixir/chat_gateway.ex` is the shared
  "post a message and start a run" entrypoint for websocket chat and scheduler
  ticks.
- `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex:396-449`
  formats due work and calls `state.chat_gateway.post_message/3`.
- `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex:416-423`
  builds a normal chat scope and injects the manager session into that scope.
- `apps/orchestrator/lib/symphony_elixir/gateway/chat_runner.ex:153-187`
  accepts caller-owned manager sessions from scheduler-injected scopes, runs
  the manager turn, and forwards events through the same gateway owner path.

So this runtime scope does not recreate a manager batch runner or message
recorder. The remaining runtime work is narrower: remove the manager-only
resolver, runner, history, and scheduler-config storage paths.

## Current Runtime Inventory

Every file:line reference below is verified against
`origin/main` at `fd71274` (post-#320, post-#321, post-#322).

### Manager SessionResolver

`apps/orchestrator/lib/symphony_elixir/manager/session_resolver.ex`

- `:16-29` keeps a manager-only supported-provider list aligned by comment to
  platform `MANAGER_PROVIDER_IDS`.
- `:31-40` defines manager-specific idle reasons.
- `:50-57` and `:128-147` fetch workspace-scoped `gateway_config`, read
  `runners.manager`, validate provider/model/credential fields, and return
  manager-specific details.
- `:163-177` is the core `runners.manager` read path.
- `:179-191` rejects providers through the manager-only allowlist.
- `:194-240` builds a runnable manager config and handles missing credential
  states.
- `:271-304` re-queries `AgentInventory` credentials and resolves secrets.

This duplicates the generic runtime-profile job. The generic resolver already
lives at
`apps/orchestrator/lib/symphony_elixir/gateway/agent_execution_profile.ex:29-40`
and reads routing rules for `runner_kind`, `provider`, and `model`.

### Gateway ChatRunner Manager Branch

`apps/orchestrator/lib/symphony_elixir/gateway/chat_runner.ex`

- `:3-9` documents manager dispatch as `Runner.Manager` via
  `Manager.SessionResolver`.
- `:20-39` branches manager agents before consulting routing-rule runner
  resolution. Non-manager agents go through `resolved_runner_kind/1`.
- `:45-55` already uses `AgentExecutionProfile.resolve/2` for non-manager
  routing-rule resolution.
- `:134-138` explicitly says manager chat reuses `Manager.SessionResolver`
  so chat and scheduler both read `runners.manager`.
- `:205-213` resolves manager sessions from workspace id only, not agent id,
  through the manager-specific resolver.
- `:216-218` falls back to `Runner.Manager`.

This is the chat-side counterpart of the scheduler duplication. Once manager
runtime profile resolution is generic, manager chat should route by
`AgentExecutionProfile.resolve/2` like every other agent.

### Manager Scheduler

`apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`

- `:8-13` documents cadence coming from
  `runners.manager.<agent_id>.min_cadence_ms` or
  `runners.manager.min_cadence_ms`.
- `:24` aliases `Manager.SessionResolver`.
- `:143-158` initializes the scheduler by resolving a manager session.
- `:224-231` refreshes cadence from `gateway_config` every tick.
- `:303-320` reads `configured_due_task_query/2` and applies it to
  `due_query/4`.
- `:502-512` reads cadence from `gateway_config.runners.manager`.
- `:524-538` reads due-task-query from `gateway_config.runners.manager`.

The scheduler is real and should stay. Its remaining problem is that
scheduler-only fields are stored inside the same `runners.manager` block that
also carries model/provider/credential fields.

### Manager Workspace Discovery

`apps/orchestrator/lib/symphony_elixir/manager/workspaces/database.ex`

- `:1-7` documents manager enablement as the presence of
  `config_json.runners.manager`.
- `:26-41` scans workspace-scoped `gateway_config` rows.
- `:51-61` treats a non-empty `runners.manager` object as an active manager
  workspace.

This should eventually discover scheduled agents from the canonical agent or
scheduler-config source, not from a workspace config object that exists because
the platform dual-writes manager runtime settings.

### Manager Runner

`apps/orchestrator/lib/symphony_elixir/runner/manager.ex`

- `:1-6` defines a manager-specific `Runner` implementation.
- `:18-55` starts a manager session, resolves credential, selects manager tool
  specs, builds prompt/model/client state, and attaches chat callback state.
- `:59-69` runs one turn using the same shape as other model/tool runners.
- `:72-78` fetches manager-specific message history.
- `:109-112` loads the manager prompt. This is valid manager-specific data.
- `:114-135` runs the model loop.
- `:137-170` executes tool calls.
- `:183-189` derives allowed tools from `ToolRegistry.bundle(:manager)` and
  executes through `ToolRegistry.execute/4`.

Much of this is not manager-only; it is the generic llm-tool-runner loop with a
manager prompt, manager tool bundle, and manager model-client choices.

### Manager MessageHistory

`apps/orchestrator/lib/symphony_elixir/manager/message_history.ex`

- `:1-15` fetches prior persisted manager messages as the read counterpart to
  `ChatGateway`.
- `:40-64` accepts a chat scope and returns history.
- `:66-92` reads message rows through `MessageLog`.
- `:101-109` keeps text-only user/assistant messages.

This is not inherently manager-specific. Any chat-backed llm-tool-runner agent
needs this same history behavior.

### Legacy Manager Runner Routing

- `apps/orchestrator/lib/symphony_elixir/execution_profile.ex:51` maps
  `"manager"` to `SymphonyElixir.Runner.Manager`.
- `apps/orchestrator/lib/symphony_elixir/execution_profile.ex:152` maps
  `Runner.Manager` back to `"manager"`.
- `apps/orchestrator/lib/symphony_elixir/runner.ex:95-105` resolves
  work-item runner type `"manager"` to `Runner.Manager`.
- `apps/orchestrator/lib/symphony_elixir/agent_runner.ex:249` has
  manager-specific runner settings.

These references can stay temporarily while the manager runner exists, but they
are part of the final cleanup.

## Proposed Runtime Architecture

Today:

```text
Manager.Scheduler
  -> Manager.SessionResolver
       -> workspace gateway_config.runners.manager
       -> manager-only provider allowlist
       -> agent_inventory credential lookup
  -> ChatGateway.post_message
       -> Gateway.ChatRunner manager branch
       -> Runner.Manager
       -> Manager.MessageHistory
```

Target:

```text
AgentScheduler
  -> SchedulerConfig.for_agent(agent_id)
  -> ChatGateway.post_message
       -> Gateway.ChatRunner
       -> AgentExecutionProfile.resolve(agent_id, workspace_id)
       -> generic llm-tool runner
            prompt = manager prompt
            tools = grant-derived manager tools
            history = generic chat message history
```

The scheduler remains a runtime service. The manager stops being a separate
runtime profile and runner architecture.

## Runtime PR Sequence

Each PR below should be independently shippable.

### Phase 1 — Resolve manager runtime profile from routing rules

Change the manager session resolution path so provider/model/credential come
from canonical routing/profile data, not `gateway_config.runners.manager`.

Implementation notes:

- Change `Manager.SessionResolver.resolve/2` and `identity/2` to require or
  derive an `agent_id`, then call
  `Gateway.AgentExecutionProfile.resolve(agent_id, workspace_id)`.
- Keep the existing public result shape temporarily so `Manager.Scheduler`,
  `Gateway.ChatRunner`, launcher routes, and tests do not all need to change
  in one PR.
- Translate generic resolver failures into existing manager idle reasons for
  compatibility:
  - `:not_found` -> `:manager_config_missing`
  - missing credential -> `:manager_credential_missing`
  - unsupported provider -> `:manager_provider_unsupported`
- Remove the `@supported_providers` source of truth from
  `Manager.SessionResolver`; provider support should come from the same
  execution-profile validation used by every other agent.
- Update `manager/session_resolver_test.exs` fixtures away from workspace
  `gateway_config.runners.manager` model/provider fields and toward
  routing-rule / agent profile fixtures.

Acceptance criteria:

- Manager scheduler still starts and reports the same status vocabulary.
- Manager chat still works through `ChatGateway`.
- No manager runtime-profile data is read from `runners.manager`.
- Scheduler cadence and due-task-query may still read from `runners.manager`
  as a transition.

### Phase 2 — Introduce SchedulerConfig storage boundary

Move the genuinely scheduler-only fields behind a small runtime module that
reads from the existing `agent_heartbeat_config` table.

Candidate module:

- `SymphonyElixir.Scheduler.Config`
- or `SymphonyElixir.Manager.SchedulerConfig` as a transitional name.

**Storage**: harper-server's `agent_heartbeat_config` table
([migration 20260302061200](https://github.com/harper-hq/harper-server/blob/main/supabase/migrations/20260302061200_create_agent_heartbeat_config.sql))
was created as "a DB-backed replacement for HEARTBEAT.md source-of-truth"
and is currently unreferenced by any production code path (zero readers
or writers in either repo — confirmed by grep across both repos). It has
the right shape:

| `gateway_config.runners.manager` field | `agent_heartbeat_config` column                       |
|----------------------------------------|-------------------------------------------------------|
| keyed by `workspace_id` + `agent_id`   | `unique (workspace_id, agent_id)`                     |
| implicit on/off via presence           | `enabled boolean not null default true`               |
| `min_cadence_ms`                       | `policy_json.cadence_ms`                              |
| `due_task_query`                       | `tasks_json: [{ kind: "due_work_items", filter }]`    |
| (no equivalent; we infer "run now")    | `heartbeat_prompt`                                    |
| —                                      | `quiet_hours_json` (new capability, optional)         |

**Generic task-kind envelope.** Scheduling is a runtime capability,
not a manager attribute (per the platform doc decision; see
[parallel-agent-platform #440](https://github.com/kmgrassi/parallel-agent-platform/pull/440)).
`tasks_json` holds an array of `{ kind, filter }` entries so future
scheduled-agent kinds can register without a schema migration:

```jsonc
[
  {
    "kind": "due_work_items",       // manager today; the first registered kind
    "filter": { "states": [...], "plan_ids": [...] }
  }
  // future: "linear_label_poll", "github_pr_review_queue", ...
]
```

The runtime's `SchedulerConfig` reader returns the raw `tasks_json`
array; trigger logic dispatches by `kind`. Today only
`"due_work_items"` is implemented (delegating to the existing manager
due-task query). Adding a new kind is a runtime change that does not
touch the table.

**Schema sync prerequisite**: `agent_heartbeat_config` is present in
the TypeScript types (`supabase/generated/types.ts` — 4 references) but
**not** in the Elixir bridge file
(`apps/orchestrator/priv/generated/postgrest-schema.json` — 0
references) because that table is not in the bridge allowlist. Before
Phase 2 can read the table, this repo must:

1. Add `agent_heartbeat_config` to the `BRIDGE_TABLES` list in
   `scripts/append-supabase-jsdoc-types.mjs` (per CLAUDE.md, this
   controls bridge inclusion).
2. Run `pnpm run supabase:schema:sync` to regenerate
   `supabase/generated/postgrest-schema.json` and
   `apps/orchestrator/priv/generated/postgrest-schema.json`.

Without the bridge entry, `SymphonyElixir.SupabaseSchema` will
`function_clause` at startup as soon as the new reader queries the
column. Land the bridge change in the same PR as Phase 2.

Fields the module exposes (the runtime contract — agnostic to which
agent type uses scheduling):

- `agent_id`
- `workspace_id`
- `enabled`
- `min_cadence_ms` (from `policy_json.cadence_ms`)
- `tasks` — list of `{ kind, filter }` entries from `tasks_json`. The
  scheduler dispatches each tick by kind. Today only `"due_work_items"`
  is implemented.
- `heartbeat_prompt` (optional — overrides the scheduler's default
  "run your due tasks" message body)
- optional metadata/version fields if platform needs optimistic updates

Implementation notes:

- Create `SchedulerConfig.for_agent(agent_id, workspace_id)` and
  `SchedulerConfig.list_enabled/0` (or equivalent) backed by a PostgREST
  read against `agent_heartbeat_config`.
- Add a small `SchedulerConfig.Task` (or similar) struct so callers
  pattern-match on `kind` rather than poking into raw JSON.
- The scheduler keeps the existing manager due-work-items query path,
  but routes through it via the new `kind: "due_work_items"` dispatch
  so the same plumbing supports future kinds.
- Change `Manager.Scheduler.configured_min_cadence_ms/2` and
  `configured_due_task_query/2` to read through `SchedulerConfig`.
- Keep a temporary fallback to `gateway_config.runners.manager` only if
  needed for rollout. If used, log it as legacy fallback so it is easy
  to delete.
- Change `Manager.Workspaces.Database` to discover enabled scheduled
  agents by listing rows in `agent_heartbeat_config` where
  `enabled = true`, instead of detecting non-empty `runners.manager`.
  This implicitly opens the door to non-manager scheduled agents — the
  bootstrapper no longer filters by agent type.

Acceptance criteria:

- Scheduler cadence + due-work-items tick fire correctly with
  `tasks_json: [{ kind: "due_work_items", filter: ... }]` and no
  `runners.manager` block.
- A scheduled non-manager agent (e.g., a planning agent with the same
  `tasks_json` row inserted manually) gets a scheduler started and a
  message posted through `ChatGateway`. Whether the *target* of that
  message makes sense for that agent type is a separate concern
  (Phase 7 in the platform doc); the runtime contract is: scheduling
  is generic.
- Existing scheduler tests cover agent-level and workspace/default
  fallback behavior in the new module.
- Platform can stop dual-writing runtime profile data without disabling
  manager scheduling.

Open question (narrower):

- **Where the schema for each task `filter` lives.** When a new task
  kind is added (e.g., `linear_label_poll`), where does the schema for
  its `filter` live? Options: (a) JSON schema files registered in the
  platform's `contracts/scheduler-task-kinds/`; (b) Zod schemas in the
  platform's existing contracts; (c) only the runtime knows the
  filter shape, platform passes-through. The platform doc
  ([#440](https://github.com/kmgrassi/parallel-agent-platform/pull/440))
  flags the same trade-off. Decide before opening the Phase 2 PR.

### Phase 3 — Delete `Manager.SessionResolver`

Once scheduler config is separated and callers have an agent id, remove the
manager resolver entirely.

Implementation notes:

- Change `Manager.Scheduler` to resolve execution profile directly, or accept
  the resolved profile as part of the chat scope.
- Change `Gateway.ChatRunner.run_manager/5` so manager chat no longer calls
  `Manager.SessionResolver.resolve(scope.workspace_id)`.
- Replace manager-prefixed idle reasons with generic resolver/status reasons
  at runtime boundaries.
- Delete `apps/orchestrator/lib/symphony_elixir/manager/session_resolver.ex`.
- Delete or rewrite `manager/session_resolver_test.exs`.
- Update `launcher/router.ex` and any status endpoint tests that alias
  `Manager.SessionResolver`.

Acceptance criteria:

- `rg "Manager.SessionResolver|manager_config_missing|manager_provider_unsupported"`
  has no runtime production references except any intentionally retained
  compatibility mapper.
- Manager chat and scheduler both use the same profile resolver as other
  agents.

### Phase 4 — Collapse `Runner.Manager` into the generic LLM tool runner

Remove the manager-specific runner module after its unique inputs have clear
data hooks.

Implementation notes:

- Extract or reuse a generic llm-tool-runner that accepts:
  - prompt loader
  - model client/provider adapter
  - allowed/effective tool definitions
  - chat history scope
  - callbacks for emitted events
- Move manager prompt loading out of `Runner.Manager.runtime_prompt/0` and into
  manager agent configuration for the generic runner.
- Select manager tools by effective grants. `ToolRegistry.bundle(:manager)` can
  remain a catalog/default helper, but runner requests should be grant-derived.
- Move manager local-relay/openai model-client differences into provider or
  execution-profile adapter selection, not a manager runner branch.
- Delete `apps/orchestrator/lib/symphony_elixir/runner/manager.ex` when the
  generic runner covers it.

Acceptance criteria:

- `Gateway.ChatRunner` no longer defaults to `Runner.Manager`.
- `ExecutionProfile` and `Runner.resolve/2` no longer special-case the manager
  runner module.
- Manager tools still execute with deny-by-default allowlist behavior.
- Manager local-relay smoke coverage still passes.

### Phase 5 — Generalize message history

Rename and generalize `Manager.MessageHistory`.

Implementation notes:

- Move `Manager.MessageHistory` to a generic module such as
  `Gateway.MessageHistory` or `Runner.MessageHistory`.
- Keep behavior from `manager/message_history.ex:40-109`: scope-based lookup,
  bounded limits, exclude current run, text-only replay, never raise.
- Update manager tests into generic message-history tests.
- Wire the generic llm-tool-runner to use this history module for all
  chat-backed agent turns that need context.

Acceptance criteria:

- No production module calls `Manager.MessageHistory`.
- The history behavior remains covered for missing scope, bad adapter
  responses, current-run exclusion, ordering, and limit clamping.

### Phase 6 — Rename scheduler-owned manager modules

After the resolver and runner are gone, rename only the leftover generic
scheduler infrastructure. Keep manager business logic under `manager/`.

Rename candidates:

- `manager/scheduler.ex` -> `scheduler/agent_scheduler.ex`
- `manager/bootstrapper.ex` -> `scheduler/bootstrapper.ex`
- `manager/supervisor.ex` -> `scheduler/supervisor.ex`
- `manager/workspaces/database.ex` -> scheduler discovery module for enabled
  scheduled agents

Keep under `manager/`:

- `manager/prompt.ex`
- `manager/tools/`
- `manager/tool_support.ex`
- `manager/artifact_state/`
- manager-specific work-item row mapping if it remains tied to manager
  semantics

Acceptance criteria:

- The `manager/` directory contains manager business logic, not generic
  scheduling/runtime plumbing.
- Module names make it clear that scheduling is a generic runtime capability
  currently used by manager agents.

## Platform Coordination

Runtime needs to land before platform deletes the dual-write.

Suggested order:

1. Runtime Phase 1: manager reads canonical routing/profile data.
2. Runtime Phase 2: scheduler fields have a non-`runners.manager` home or
   storage boundary.
3. Platform #440 phase 2: remove `gateway_config.runners.manager` dual-write
   for runtime profile fields.
4. Runtime Phase 3 through Phase 6: delete compatibility modules and rename
   the remaining scheduler infrastructure.

## Verification

Focused runtime tests:

- `mix test test/symphony_elixir/manager/session_resolver_test.exs`
- `mix test test/symphony_elixir/manager/scheduler_test.exs`
- `mix test test/symphony_elixir/gateway/chat_runner_test.exs`
- `mix test test/symphony_elixir/runner/manager_test.exs`
- `mix test test/symphony_elixir/manager/message_history_test.exs`
- `mix test test/symphony_elixir/integration/manager_local_smoke_test.exs`

Repository checks:

- `rg "runners\\.manager" apps/orchestrator/lib apps/orchestrator/test`
  should shrink to only scheduler-config fallback during transition, then zero
  for runtime-profile resolution.
- `rg "Manager.SessionResolver" apps/orchestrator/lib` should be zero after
  Phase 3.
- `rg "Runner.Manager" apps/orchestrator/lib` should be zero after Phase 4.

End-to-end checks:

- Manager scheduler tick posts through `ChatGateway` and completes a manager
  run.
- Websocket chat to a manager agent uses the same execution profile as a
  scheduler-triggered manager run.
- Updating a manager runtime profile in platform changes the next runtime turn
  without writing `gateway_config.runners.manager`.
- Updating scheduler cadence/due-task-query changes polling behavior without
  touching model/provider/credential settings.
