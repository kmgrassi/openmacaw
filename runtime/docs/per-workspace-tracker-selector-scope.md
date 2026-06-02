# Per-Workspace Tracker Selector — Runtime Scope

Companion to:

- `parallel-agent-platform/docs/active/per-workspace-tracker-selector-scope.md`
- `harper-server` scope doc (same filename)

## Premise

Today the orchestrator uses a single global `Tracker` adapter selected at
boot time from `config.tracker.kind` (`tracker.ex:43-50`). One process =
one tracker kind. To let users pick where their work items live (database,
Linear, GitHub Issues, memory, api), the choice has to move from boot-time
config to **per-workspace** runtime state, stored in
`workspace_settings.tracker_kind` and resolved on every Tracker call.

This doc scopes the runtime-side changes only. UI and credential surfaces
are in the platform doc; the schema additions are in the harper-server
doc.

## Current State

- `SymphonyElixir.Tracker` (`apps/orchestrator/lib/symphony_elixir/tracker.ex`)
  declares a behaviour with five callbacks (`fetch_candidate_issues`,
  `fetch_issues_by_states`, `fetch_issue_states_by_ids`, `create_comment`,
  `update_issue_state`). None take a `workspace_id`.
- `Tracker.adapter/0` reads `Config.settings!().tracker.kind` and returns
  one of `SymphonyElixir.Tracker.{Memory, Database, GitHub, API, Linear}`.
- Supported kinds today: `linear | memory | database | github | api`
  (`config.ex:160`).
- The orchestrator (`orchestrator.ex`) calls `Tracker.fetch_candidate_issues/0`
  on each poll tick (`orchestrator.ex:237`). The poll loop has no concept
  of workspaces — it gets a flat list and dispatches.
- `BrokerLog` records `tracker_kind` per run (`broker_log.ex:71, 347`),
  pulled from the same global config.

## Target State

- `Tracker.adapter(workspace_id)` returns the adapter for that workspace,
  reading `workspace_settings.tracker_kind` via PostgREST. Falls back to
  `database` when no row exists (matches `workspace_settings`'s lazy-row
  convention).
- Every callback takes `workspace_id` as its first arg.
- **Each orchestrator instance stays scoped to its own workspace.** The
  runtime already launches a separate orchestrator per agent via
  `Orchestrator.Starter`/`AgentStarter`, with `workspace_id` injected
  from `stored_agent.workspace_id` at launch time
  (`orchestrator/starter.ex:236`). The poll loop resolves the
  instance's workspace and polls only that one. The in-memory
  `running`/`claimed` guards remain process-local; cross-instance
  races are avoided by construction (one instance owns one workspace's
  dispatch).
- Boot-time `config.tracker.kind` is removed in the cutover PR. No
  backwards-compatibility shim.

## Phased Work (Parallelizable)

The runtime slice splits into five PRs. RUNTIME-1 is independent and can
start in parallel with the harper-server migration; the rest gate on it.

### RUNTIME-1 — Add `workspace_id` Param Through The Tracker Behaviour

- Change every `@callback` in `tracker.ex` to take `workspace_id` as
  the first argument.
- Update every adapter (`tracker/memory.ex`, `tracker/database.ex`,
  `tracker/github.ex`, `tracker/api.ex`, `tracker/linear.ex`) to accept
  the new arg. Adapters that currently ignore workspace (Memory) can
  ignore the parameter; the database adapter starts filtering by it.
- Update every caller (the orchestrator, BrokerLog, any tests).
- In this PR, `Tracker.adapter(workspace_id)` still returns the global
  `Config.settings!().tracker.kind` adapter — the per-workspace lookup
  lands in RUNTIME-2. The point of RUNTIME-1 is to plumb the parameter
  without changing behaviour.

**Independent**: can start before harper-server migration merges.

### RUNTIME-2 — Resolve Tracker Kind From `workspace_settings`

- `Tracker.adapter(workspace_id)` queries `workspace_settings` via
  PostgREST for that workspace's `tracker_kind`.
- Falls back to `database` when no row exists, matching the
  workspace_settings convention (rows created lazily on first write).
- Cache: since each orchestrator instance owns one workspace (see
  RUNTIME-3), the cache is effectively a single resolved value
  per process. Implement as a field on `Orchestrator.State` populated
  on first resolution, with a short TTL (~30s) or explicit
  invalidation.
- Cache invalidation hook for the planner tool (RUNTIME-4) and platform
  API writes to call, so a user-driven tracker change takes effect
  faster than the TTL.

**Gates on**: harper-server PR adding `workspace_settings.tracker_kind`.

### RUNTIME-3 — Poll The Instance's Own Workspace

The orchestrator's poll tick currently calls
`Tracker.fetch_candidate_issues/0` with no workspace context.

**New behaviour: resolve the instance's workspace once at boot and pass
it on every Tracker call.** Do NOT enumerate the `workspaces` table.
The launcher already starts one orchestrator per agent via
`Orchestrator.Starter`, and `build_stored_agent_config/1`
(`orchestrator/starter.ex:236`) already takes `workspace_id` from the
launched `stored_agent`. The orchestrator can read its own workspace
from the same config it already receives at startup.

Concrete steps:

- Extract the instance's `workspace_id` from the orchestrator's
  startup config (where `stored_agent.workspace_id` lives) and store
  it in `Orchestrator.State`.
- Every poll-tick caller path that today invokes
  `Tracker.fetch_candidate_issues/0` becomes
  `Tracker.fetch_candidate_issues(state.workspace_id)`. Same for
  `fetch_issues_by_states`, `update_issue_state`, `create_comment`.
- BrokerLog records the per-run tracker_kind from the resolved
  adapter for that workspace.

**Why not enumerate workspaces here**: each agent's orchestrator only
owns its own agent's work. If a single orchestrator process scanned
all workspaces, multiple processes would race over the same
`work_items` rows because the `running`/`claimed` sets are
process-local. Keeping one instance = one workspace preserves the
existing isolation guarantee.

If we later want a single "global poller" that fans out across
workspaces, that is a distinct design (likely a separate supervised
process with cross-instance coordination via a DB advisory lock or
similar) — explicitly out of scope here.

**Gates on**: RUNTIME-1 (callback signatures), RUNTIME-2 (resolution
path).

### RUNTIME-4 — Planner Tool `workspace_settings.update_tracker_kind`

- New planner tool registered in
  `apps/orchestrator/lib/symphony_elixir/tool_registry.ex` and
  implemented under `apps/orchestrator/lib/symphony_elixir/planner/tools/`.
- Tool name: `workspace_settings.update_tracker_kind` (follows the
  `resource.action` CRUD convention from platform CLAUDE.md).
- Arguments:
  - `tracker_kind` (string, enum sourced from harper-server CHECK)
  - `credential_id` (uuid, required when `tracker_kind in (linear, github)`)
- Writes to `workspace_settings` via PostgREST, invalidates the RUNTIME-2
  cache for that workspace, returns the resulting row.
- Bundle: add to `:planner` (and possibly `:manager`) so the planning
  agent can switch the tracker from chat.

**Gates on**: RUNTIME-2 (resolution + cache invalidation hook).

### RUNTIME-5 — Cutover: Remove Boot-Time `config.tracker.kind`

- Delete `config.tracker.kind` from the config schema
  (`config/schema.ex`) and from `config.ex` validation.
- `Tracker.adapter/0` (zero-arity) is removed. All callers go through
  `Tracker.adapter(workspace_id)`.
- Update CLAUDE.md to reflect the new contract.

**Gates on**: RUNTIME-1..4 and the platform UI + harper-server migration
all in production.

## Test Cases

### Unit: `Tracker.adapter(workspace_id)` returns per-workspace kind

```
given:  workspace W1 has workspace_settings.tracker_kind = "linear"
        workspace W2 has no workspace_settings row
when:   Tracker.adapter(W1) and Tracker.adapter(W2)
then:   W1 -> SymphonyElixir.Tracker.Linear
        W2 -> SymphonyElixir.Tracker.Database  (default fallback)
```

### Unit: `Tracker.adapter` cache invalidation

```
given:  workspace W with tracker_kind = "database", queried once
when:   workspace_settings.update_tracker_kind tool runs with kind = "memory"
then:   subsequent Tracker.adapter(W) returns Memory adapter without
        waiting for the TTL
```

### Integration: Orchestrator polls only its own workspace

```
given:  two orchestrator instances:
        - O1 launched with stored_agent.workspace_id = W1 (kind=database)
        - O2 launched with stored_agent.workspace_id = W2 (kind=memory)
        - both workspaces have candidate work_items in their tracker
when:   each orchestrator poll tick fires
then:   O1 only sees and dispatches W1's items (read via the database
        adapter scoped to W1)
        O2 only sees and dispatches W2's items (read via the memory
        adapter scoped to W2)
and:    no work item is dispatched twice
and:    BrokerLog records the correct tracker_kind per run
```

### Negative: workspace_id absent at launch fails fast

```
given:  Orchestrator.Starter is invoked without a stored_agent.workspace_id
when:   the orchestrator initializes
then:   it raises (or returns {:error, :missing_workspace_id}) instead of
        falling back to "all workspaces" — the missing scope is the
        bug, not something to paper over
```

### Negative: GitHub/Linear kind without credential rejects

```
given:  workspace_settings.tracker_kind = "linear", credential_id is null
when:   Tracker.adapter(workspace_id) resolves
then:   :error {:missing_tracker_credential, "linear"}
and:    the orchestrator skips this workspace's poll for the tick,
        logs a warning, surfaces a workspace-visible error event
```

### Negative: invalid `tracker_kind` value is rejected at the tool

```
given:  planner agent calls workspace_settings.update_tracker_kind
        with tracker_kind = "jira"
then:   tool returns an error citing the supported set; no DB write
```

### Browser smoke

Extends the existing planner work-item smoke in
`apps/orchestrator/CLAUDE.md`:

1. As an authenticated user, open settings, switch the workspace
   tracker from `database` to `memory`.
2. Ask the planner to create a plan with one work item.
3. Confirm the orchestrator's next poll reads from the memory adapter
   (work item visible there, not in `work_items` table — or simply
   check broker logs for tracker_kind = memory).
4. Switch back to `database`. Confirm subsequent items go into
   `work_items`.

## Non-Goals

- Per-workspace tracker credentials beyond Linear and GitHub.
- Multi-tracker per workspace (e.g., "read from Linear, write to DB").
  One kind per workspace.
- Migrating existing rows when a workspace switches kinds. Switching is
  effective for new items only; historical rows stay where they were
  written.
- Per-workspace polling cadence override. The global
  `polling.interval_ms` continues to control tick frequency.

## Open Questions

- Should `Tracker.adapter/1` ever return an error tuple, or always raise
  on unresolved kind? Default proposal: error tuple, so the orchestrator
  poll loop can skip that workspace gracefully and continue.
- Should the RUNTIME-2 cache TTL be configurable? Default proposal: yes,
  via `config.tracker.cache_ttl_ms`, defaulting to 30_000.
- BrokerLog currently has a `tracker_kind` column populated from global
  config. Confirm it now sources from the resolved per-workspace
  adapter (no schema change, just code).

## Companion PRs / Cross-Repo Pieces

- **parallel-agent-platform**: settings UI, API endpoints, credential
  picker — see platform scope doc.
- **harper-server**: migration adds `workspace_settings.tracker_kind`
  (text + CHECK, default `database`) and `workspace_settings.tracker_credential_id`
  (nullable uuid FK to `credential.id`) — see harper-server scope doc.
