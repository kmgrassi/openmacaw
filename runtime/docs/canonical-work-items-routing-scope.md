# Canonical Work Items Routing Scope

Supersedes the closed `docs/planning-front-door-runtime-scope.md` proposal
(PR #367) and the platform-side single-chat dashboard framing.

## Premise

The planning agent is not a special class of agent. It is a regular agent that
the user happens to chat with, whose primary job is to **produce structured
plans and work items in the canonical schema the orchestrator already routes**.

The orchestrator (`SymphonyElixir.Orchestrator`) is already the routing layer.
Today it polls a `Tracker` adapter for eligible `WorkItem`s, applies
`DispatchPolicy`, and spawns an `AgentRunner` per eligible item. That pipeline
should be the only path by which background work is dispatched — including
work produced by the planning agent.

So the contract that matters is not "what tools does the planner have." It is
**what shape the planner's tool calls write into `work_items`** so the
orchestrator can route them. Storage backend (Linear, Supabase, GitHub Issues)
is a `Tracker` adapter concern and stays orthogonal.

## Why The Previous Framing Was Wrong

The closed `planning-front-door-runtime-scope.md` proposed:

- a new `:planning_front_door` tool bundle,
- a new delegation tool with parent/child run linkage,
- new message visibility metadata (`user_visible | summary | debug | system`),
- a worker-summary injection mechanism.

That framing tried to bolt event-routing semantics onto the runtime as a side
channel for the planner specifically. But:

- `WorkItem` (`apps/orchestrator/lib/symphony_elixir/work_item.ex`) is already
  the normalized struct every input source produces.
- `Tracker` (`apps/orchestrator/lib/symphony_elixir/tracker.ex`) is already the
  adapter boundary, with `memory | database | github | api | linear` kinds.
- `task.create` (`apps/orchestrator/lib/symphony_elixir/planner/`
  `database_tools.ex:72-101`) already writes directly into the `work_items`
  table.
- `Orchestrator` already polls `Tracker.fetch_candidate_issues/0` and dispatches
  via `DispatchPolicy` and `AgentRunner.run/2`.

The planner does not need a private dispatch channel. It needs to write
work items whose fields the orchestrator can route on.

## Current Schema (harper-server)

`work_items` columns today, from
`harper-server/supabase/migrations/`:

- core: `id`, `identifier`, `title`, `description`, `state`, `priority`,
  `labels`, `source`, `metadata`, `created_at`, `updated_at`
- linkage: `task_id`, `plan_id`, `workspace_id`
- runner brief (OQ-01): `instructions`, `depends_on`, `completion_gates`

`plan` columns:

- `metadata`, `schema_version`, `intent`, `default_runner_kind`,
  `default_model`

`routing_rule` carries the canonical `runner_kind` check constraint that the
orchestrator uses to pick an executor.

## Gaps For Multi-Repo, Multi-Runner Plans

The motivating use case is: a single plan that produces N work items targeting
different repositories, each potentially routed to a different runner. To do
that through the canonical pipeline, two routing dimensions need to be
first-class on `work_items`:

### 1. Per-Item Runner Selection

Today only `plan.default_runner_kind` exists. A plan-level default is fine, but
the planner should be able to override it per work item using canonical runtime
runner kinds (e.g., one item runs `local_model_coding`, another runs `codex`).
This belongs on `work_items` as a nullable column constrained to the same
`runner_kind` values as `routing_rule` (single source of truth, per
`[[feedback_no_hardcoded_enums]]`).

### 2. Per-Item Repository Target

Today repository routing lives in `work_items.metadata` (no first-class
column). For the "10 PRs across 10 repos" case the orchestrator must filter
and dispatch by repository on a hot path. This belongs as a first-class
column (FK or stable identifier — pick whichever matches the existing repo
registry).

### 3. Planner Tool Schema Surface

`task.create`'s JSON schema does not currently expose `runner_kind` or
`repository`, so the planner cannot populate them even via `metadata`
without out-of-band convention. The tool definitions in
`apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex` need
arguments for these dimensions, with values pulled from the same enum
source as `routing_rule`.

### 4. Tracker Adapter Parity For Writes

`Tracker` callbacks today are read-heavy: `fetch_candidate_issues`,
`fetch_issues_by_states`, `create_comment`, `update_issue_state`. There is
no `create_issue` callback. That is fine as long as `database` is the
canonical write path: planner tools write `work_items` rows directly via
`PostgRESTClient`, and other trackers (`linear`, `github`) are read-mirrors
of external state.

If the team wants planners to file Linear issues or GitHub Issues *as the
canonical record*, the `Tracker` behaviour needs a uniform create path. The
recommended posture for now: **`database` is canonical**; Linear/GitHub
adapters remain read-only mirrors of external trackers and do not need a
create path.

## How Work Items Reach The Orchestrator

There is no separate queue. The `work_items` table itself is the queue.
Handoff is automatic, poll-based, and data-driven:

1. The planner agent's tool call executes `task.create` synchronously,
   writing a row to `work_items` via `PostgRESTClient`
   (`planner/database_tools.ex:72-101`). The tool call returns the
   `work_item_id` to the planner; no further runtime action is needed
   to "submit" the item.
2. The orchestrator GenServer polls on a tick scheduled by
   `schedule_tick` (`orchestrator.ex:109`). The interval comes from
   `config.polling.interval_ms`, default `30_000` ms
   (`config/schema.ex:131`).
3. On each tick the orchestrator calls
   `Tracker.fetch_candidate_issues/0` (`orchestrator.ex:237`). With
   `tracker.kind = "database"`, this reads `work_items` directly via
   PostgREST and returns `WorkItem` structs.
4. Each candidate runs through
   `DispatchPolicy.dispatch_eligible?/2` (`dispatch_policy.ex:18-42`),
   which gates on:
   - candidate `state` is in the configured active states;
   - not blocked by non-terminal `depends_on` dependencies;
   - not already claimed or running;
   - global concurrency slot available (`max_concurrent_agents`);
   - per-state concurrency slot available.
5. Eligible items are sorted by priority and `created_at`, then
   dispatched to `AgentRunner.run/2` via `Task.Supervisor.start_child`
   (`orchestrator.ex:587-589`).

**Latency**: a new `work_items` row is picked up within one poll
interval — about 30 seconds with default config, configurable down.
There is no push signal today.

**Push-based dispatch is out of scope**. If we later need sub-second
pickup, the natural options are Phoenix.PubSub broadcasts from the
planner's tool execution back into the orchestrator GenServer, or
Postgres `LISTEN`/`NOTIFY` on `work_items` inserts. Either is a
follow-up — the current poll-based path already proves the routing
contract end to end.

## Test Cases

These are concrete enough to implement as part of RUNTIME-5 smoke
coverage and the unit tests that flank it.

### Unit: `task.create` writes a routable work item

File: `apps/orchestrator/test/symphony_elixir/planner/database_tools_test.exs`
(extend existing test module).

```
given:  a workspace_id W and a plan_id P
when:   PlannerToolExecutor executes task.create with
        { title: "Refactor login", runner_kind: "codex",
          repository: "parallel-agent-platform", plan_id: P }
then:   a work_items row exists with
        - workspace_id = W
        - plan_id = P
        - title = "Refactor login"
        - runner_kind = "codex"
        - repository = "parallel-agent-platform"
        - source = "planner"
        - state = draft (or whatever the configured initial state is)
and:    the tool result contains the work_item_id
```

### Unit: `plan.create` + multi-repo `task.create` produces inheriting items

```
given:  plan.create with default_runner_kind = "codex"
when:   task.create x3 with repository = "repo-a" | "repo-b" | "repo-c"
        and no runner_kind override
then:   three work_items rows exist, all with runner_kind = "codex"
        (inherited via plan.default_runner_kind), one per repository
```

### Unit: per-item `runner_kind` override beats plan default

```
given:  plan.create with default_runner_kind = "codex"
when:   task.create with runner_kind = "local_relay"
then:   the resulting work_item has runner_kind = "local_relay"
        (override wins; plan default does not overwrite it)
```

### Integration: planner chat → orchestrator dispatch

File: `apps/orchestrator/test/symphony_elixir/integration/planner_local_smoke_test.exs`
(extend existing planner smoke).

```
given:  orchestrator running with tracker.kind = "database" and
        poll_interval_ms = 1_000 (fast for the test)
when:   a chat message asks the planner to "create a plan with three
        tasks, one each in repo-a (codex), repo-b (codex), repo-c
        (local_model_coding)"
and:    the planner agent's LLM is stubbed to emit the expected
        plan.create + 3 task.create tool calls
then:   within 3 seconds, three AgentRunner.run/2 spawns have occurred
        (assert via Task.Supervisor children or a probe), each with the
        runner_kind/repository the planner declared
```

### Negative: missing repository on a multi-repo plan blocks dispatch

```
given:  a plan declares default_repository = nil and an item omits
        repository
when:   the orchestrator's poll tick runs
then:   DispatchPolicy returns false for that item (no eligible runner
        match), and the orchestrator leaves the item in its current state
        rather than dispatching it to the wrong repo
```

This case anchors RUNTIME-3's "if no worker matches, mark the item
`needs_attention` rather than running it against the wrong repo."

### Browser smoke (extends the existing CLAUDE.md procedure)

Extend `apps/orchestrator/CLAUDE.md` "Browser Login And Planner Work
Item Smoke" with a multi-repo variant:

1. Prompt: "Create a plan named Multi Repo Smoke with three tasks: one
   in `repo-a` using runner_kind codex, one in `repo-b` using codex,
   one in `repo-c` using local_model_coding."
2. Query `work_items` and assert three rows with the right
   `runner_kind` / `repository` columns and a shared `plan_id`.
3. Wait for one poll interval, then query orchestrator status (or run
   logs) and assert three child runs were started against the three
   declared repos.

## Proposed Runtime Work

### RUNTIME-1 — Extend `task.create` Tool Schema

In `database_tools.ex`, add to the `task.create` argument schema:

- `runner_kind`: optional, enum sourced from `routing_rule.runner_kind`
  check constraint.
- `repository`: optional, string identifier matching the repo registry shape
  used by `repository_tools.ex` and `RepositoryIndex`.

Both should be writable into first-class `work_items` columns once the
harper-server migration lands (see migration scope). Until then, pass them
through `metadata` and document the field names.

### RUNTIME-2 — Extend `plan.create` Tool Schema

Add `default_repository` alongside the existing `default_runner_kind` so a
plan can declare its primary repo. Items inherit if not overridden.

### RUNTIME-3 — Orchestrator Routing By Repository

`DispatchPolicy` (`orchestrator/dispatch_policy.ex`) and the agent
selection path must read `work_items.repository_id` and pick the worker
agent configured for that repo. If no worker matches, mark the item
`needs_attention` rather than running it against the wrong repo.

### RUNTIME-4 — Drop The Planner "Front Door" Concept

- Delete `docs/planning-front-door-runtime-scope.md` (this PR).
- No new `:planning_front_door` tool bundle.
- No parent/child run linkage, visibility metadata, or worker summary
  injection. The plan + work_items + orchestrator events already give
  Platform everything it needs to render status; see the platform-side
  scope doc for the dashboard view.

### RUNTIME-5 — Smoke Coverage

Add a smoke test that:

- has the planner agent receive a chat message,
- calls `plan.create` + multiple `task.create` calls targeting different
  repositories and runner_kinds,
- confirms the orchestrator polls the resulting `work_items` and dispatches
  the correct runner per item.

This is the only "front door" test we need: it proves the canonical pipeline
works end-to-end through the planner.

## Non-Goals

- Special chat UI mode (covered/closed in platform scope).
- Parent/child run linkage tables.
- Message visibility taxonomy.
- A planner-specific delegation tool. Delegation = writing a `work_items` row.

## Cross-Repo Pieces

- **harper-server**: migration adds `work_items.runner_kind` and
  `work_items.repository_id` (or equivalent FK). See
  `harper-server/supabase/migrations/` companion PR.
- **parallel-agent-platform**: dashboard surface shifts from "single chat
  with workers folded as summaries" to "plan + work_items board with live
  state pulled from the canonical table." See platform scope doc.

## Acceptance Criteria

- The planner can produce, via tool calls, a plan plus a set of work items
  that target multiple repos and runner kinds.
- The orchestrator dispatches each item to the correct runner without any
  planner-specific routing code path.
- `Tracker.Database` reads those rows the same way it reads any other
  `work_items` row; no special-case branch.
- `docs/planning-front-door-runtime-scope.md` is deleted; no new bundle,
  delegation contract, or visibility metadata is added.

## Open Questions

- Should `work_items.repository_id` be a UUID FK to a `repository` table, or
  a stable string identifier matching `RepositoryIndex` keys? Decide in the
  migration PR based on what already exists in harper-server.
- Should `task.update` also be able to *change* `runner_kind` /
  `repository_id` post-creation, or are those write-once? Default: writable
  until state moves out of `draft`.
- Are there work items the planner produces that should *not* be assigned to
  any worker (research notes, decisions, follow-ups)? If yes,
  `assigned_to_worker = false` already exists on the struct — confirm the
  tool surface exposes it.
