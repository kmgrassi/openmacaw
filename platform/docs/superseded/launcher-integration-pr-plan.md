# Launcher Integration — Implementation PR Plan

> **Platform-repo copy.** The source of truth lives in the runtime repo at
> [docs/launcher-integration-pr-plan.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/launcher-integration-pr-plan.md).
> Links below that point into the runtime repo are GitHub URLs; links to
> platform-local files (the architecture doc, `supabase/generated/database.types.ts`)
> are relative paths. Sync this copy manually if the runtime version changes.

Concrete, PR-scoped work items for finishing the Launcher integration.

Authoritative references (read before editing this plan):

- [docs/launcher-architecture-and-cross-repo-integration.md](./launcher-architecture-and-cross-repo-integration.md) — target cross-repo architecture
- [apps/orchestrator/docs/worker_bridge_and_websocket_architecture.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/worker_bridge_and_websocket_architecture.md) — how launcher `worker-bridge` and runtime `/ws` split
- [apps/orchestrator/docs/worker-bridge.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/worker-bridge.md) — the shipped worker-bridge HTTP contract
- [apps/orchestrator/docs/runtime_websocket_gateway_contract.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/runtime_websocket_gateway_contract.md) — the shipped `/ws` contract
- [apps/orchestrator/docs/db_agent_inventory.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/db_agent_inventory.md) — how the launcher already reads Supabase `agent` and `credential`
- [supabase/generated/database.types.ts](../../supabase/generated/database.types.ts) — live Supabase schema (source of truth for table shapes)

This document is organized by PR. Per-file task tracking lives in
[docs/implementation-tasks.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/implementation-tasks.md) in the runtime repo.

---

## Key reframing (read this first)

Earlier drafts of this plan assumed we'd create new `projects`, `project_tracker`, and
`orchestrators` tables. **We do not need any of those.** The platform's Supabase schema
already has the right tables — they were built during a previous integration attempt
(called "broker"). We're adopting that schema and the previous attempt's runtime under
the name "Launcher."

### Schema mapping — new concept → existing table

| Concept | Existing table / function | Notes |
|---|---|---|
| Multi-tenant boundary | [`workspaces`](../../supabase/generated/database.types.ts#L3495) + [`workspace_members`](../../supabase/generated/database.types.ts#L3459) + `is_workspace_member()` | Already the scope for agents, work_items, engine_instances. Don't create `projects`. |
| Durable agent identity | [`agent`](../../supabase/generated/database.types.ts#L265) | Has `workspace_id`, `model_settings`, `tool_policy`, `status`, `current_version`. Created by the web client before the launcher starts anything. |
| Agent credentials | `credential` | Already resolved at launch time by `WorkerBridge.CredentialResolver`. |
| Running orchestrator process | [`engine_instance`](../../supabase/generated/database.types.ts#L1260) | `instance_id`, `host`, `port`, `role`, `status`, `started_at`, `last_health_at`, `agent_id`, `workspace_id`, `ws_connection_id`. **This is what the launcher should write on start/stop.** |
| Launch config (tracker + runners) | [`gateway_config`](../../supabase/generated/database.types.ts#L1400) + `gateway_config_versions` + `gateway_config_state` | Versioned, hashed, scoped config with sync status. Scoped by `(scope_type, scope_id)` — likely `('agent', <agent_id>)` or `('workspace', <workspace_id>)`. Confirm during OR-5. |
| Execution log (per-run) | [`broker_run`](../../supabase/generated/database.types.ts#L761) | `agent_id`, `workspace_id`, `tracker_kind`, `tracker_issue_key`, `issue_identifier`, `status`, `attempt`, `input`, `output`, `codex_session_key`. **This is the persistent orchestrator-run log.** |
| Per-turn token usage | [`broker_task`](../../supabase/generated/database.types.ts#L874) | Child of `broker_run`. `input_tokens`, `output_tokens`, `total_tokens`, `last_event`, `lease_expires_at`. |
| Work item queue | `work_items` + `work_item_comments` + `plan` + `task` | Canonical task row is `task`; `work_items` is a projection via `_task_to_work_item_metadata()`. See OR-3. |
| Auth | `current_app_user_id()` + `oauth_state` + Supabase Auth | Already working. Don't reinvent. |

### Endpoint mapping — doc → shipped endpoint

| Old doc name | Actual shipped name | Location |
|---|---|---|
| `POST /orchestrators` | `POST /agents/:id/start` | [db_agent_inventory.md:31](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/db_agent_inventory.md#L31) |
| `GET /orchestrators` | `GET /agents` | [db_agent_inventory.md:23](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/db_agent_inventory.md#L23) |
| `GET /orchestrators/:id` | `GET /agents/:id` | [db_agent_inventory.md:27](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/db_agent_inventory.md#L27) |
| Session lifecycle | `POST/GET/DELETE /worker-bridge/sessions[/:id]` | [worker-bridge.md:46](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/worker-bridge.md#L46) |
| Runtime chat transport | `GET /ws` (per-orchestrator) | [runtime_websocket_gateway_contract.md:33](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/runtime_websocket_gateway_contract.md#L33) |

The doc at [launcher-architecture-and-cross-repo-integration.md](./launcher-architecture-and-cross-repo-integration.md) still
uses the old `/orchestrators` naming. Update is tracked in OR-B.

---

## Current state (as of 2026-04-22)

### Orchestrator repo — implemented

- Launcher GenServer, DynamicSupervisor, persistence (`SymphonyElixir.Launcher.*`)
- Launcher HTTP router on `:4100` exposing:
  - `GET /agents`, `GET /agents/:id`, `GET /agents/:id/credentials`, `POST /agents/:id/start` (DB-backed agent inventory)
  - `POST/GET/DELETE /worker-bridge/sessions[/:id]` (worker-bridge process lifecycle)
- Runtime `/ws` gateway (PR #23) with scope `(agent_id, workspace_id, session_key)` and `chat.send/chat.abort`, `hello-ok` framing
- `SymphonyElixir.WorkItem` struct + tracker adapters: `Memory`, `Database`, `GitHub`, `API`
- `POST /api/v1/items` endpoint
- Runner behavior + `Codex`, `OpenClaw`, `ComputerUse`, `Mock`
- Launcher reads `agent` + `credential` from Supabase; uses a launcher-owned base template and injects `config["stored_agent"]` at start

### Orchestrator repo — gaps

- `Linear.Adapter` not moved to `Tracker.Linear`; `Linear.Issue` still referenced outside the migration helper
- `Tracker.Database` row-mapping does not match live schema (priority type, missing `url` column, wrong default comments table, `plan_id`/`task_id` dropped). See OR-3.
- Launcher does not write to `engine_instance` on start/stop. See OR-4.
- Launcher uses a local base template + stored-agent injection for launch config; it does not read `gateway_config` or report sync status back via `gateway_config_state`. See OR-5.
- Orchestrator does not persist execution logs to `broker_run` / `broker_task`. See OR-6.
- Prompt templates still use `{{ issue.* }}` instead of `{{ item.* }}`. See OR-A.
- `architecture-launcher-integration.md` still uses `/orchestrators` naming. See OR-B.

### Platform repo — not started

No items from [architecture §What the other repo needs to build](./launcher-architecture-and-cross-repo-integration.md#what-the-other-repo-needs-to-build) exist yet. Enumerated as PL-* below.

---

## Minimum end-to-end scope

**End-to-end** means: logged-in user picks or creates an agent in the web client →
API server tells the launcher to start that agent → runtime boots → user lands on a
dashboard that streams chat over runtime `/ws` and shows the agent running.

Minimum PRs for the demo:

| Layer | PR | Gives you |
|---|---|---|
| DB | **PL-0** | `task → work_items` projection trigger verified |
| Orchestrator | **OR-3** | Database tracker adapter matches live schema; writes state back to canonical `task` |
| Orchestrator | **OR-4** | Launcher writes `engine_instance` rows so the platform can discover host/port |
| Orchestrator | **OR-5** | Launcher reads launch config from `gateway_config` instead of local template |
| Platform | **PL-1** | API server can call `/agents`, `/agents/:id/start`, `/worker-bridge/*`, `/ws` |
| Platform | **PL-2** | Browser `/ws` ↔ runtime `/ws` proxy + `/api/agents/*` proxy |
| Platform | **PL-3** | Auth + agent creation + `gateway_config` seeding + MVP dashboard |

Not required for Phase 1: OR-1/2 (migration polish), OR-6 (execution log persistence), OR-A/B (docs + templates), PL-4 (external ingest), PL-5 (dashboard polish).

---

## Dependency graph

```
  PL-0 (verify task → work_items trigger)
     │
     ▼
  OR-1 (WorkItem migration)
     └─► OR-2 (Tracker.Linear move)
             └─► OR-3 (Tracker.Database ↔ live schema + canonical task writeback)

  OR-4 (engine_instance writeback) ──┐
                                      │
  OR-5 (gateway_config read + state)──┼─► PL-1 (Launcher HTTP client, real endpoints)
                                      │         └─► PL-2 (/ws + /api/agents proxy)
  OR-6 (broker_run / broker_task log)─┘                 └─► PL-3 (auth + wizard + MVP dashboard)
                                                                └─► PL-4 (work-item ingest)
                                                                └─► PL-5 (dashboard polish)

  OR-A (prompt `issue` → `item`)    ← independent, ship any time
  OR-B (rename /orchestrators in architecture doc) ← independent, ship any time
```

---

## Orchestrator PRs (this repo)

### OR-1 — Finish `Linear.Issue` → `WorkItem` migration

- [ ] Audit remaining `Linear.Issue` references: `grep -rn "Linear\.Issue" apps/orchestrator/lib apps/orchestrator/test`
- [ ] Update `apps/orchestrator/lib/symphony_elixir/codex/dynamic_tool.ex` to use `WorkItem`
- [ ] Update any test fixtures / helpers still constructing `%Linear.Issue{}`
- [ ] Update `Tracker` behavior typespecs ([tracker.ex:8-12](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/lib/symphony_elixir/tracker.ex#L8)) from `[term()]` to `[WorkItem.t()]`
- [ ] Delete `apps/orchestrator/lib/symphony_elixir/linear/issue.ex` once unreferenced
- [ ] Remove `WorkItem.from_legacy_issue/1`
- [ ] Verify `mix test` + `mix dialyzer` clean

**Dependencies:** none. **Risk:** low — mechanical.

---

### OR-2 — Move `Linear.Adapter` to `Tracker.Linear`

- [ ] Create `apps/orchestrator/lib/symphony_elixir/tracker/linear.ex` as `SymphonyElixir.Tracker.Linear`
- [ ] Move the Linear HTTP client alongside or leave under `Linear.Client`
- [ ] Update `Tracker.adapter/0` to route `"linear"` → `SymphonyElixir.Tracker.Linear`
- [ ] Remove the wildcard fallback at [tracker.ex:46](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/lib/symphony_elixir/tracker.ex#L46); unknown `tracker.kind` must raise
- [ ] Update supervision and all `alias SymphonyElixir.Linear.Adapter` references

**Dependencies:** OR-1. **Risk:** low — pure rename.

---

### OR-3 — Align `Tracker.Database` with live Supabase schema; write back to canonical `task`

#### Design decision: `task` is canonical, `work_items` is a projection

The `_task_to_work_item_metadata(t_row)` function in Supabase confirms `task → work_items`
is the projection direction. The orchestrator reads from `work_items` (cheap unified queue),
writes state back to `task` via `work_items.task_id`. Comments still go to `work_item_comments`.

#### Schema / data-model

- [ ] Promote `plan_id` and `task_id` from `WorkItem.metadata` to first-class fields:
      ```elixir
      defstruct [..., :plan_id, :task_id, ...]
      ```
- [ ] Change `WorkItem.priority` to `String.t() | nil` (matches Supabase + Linear), or add string→integer coercion. Pick one, update struct, `Linear.Client`, `Tracker.Memory`.
- [ ] Drop `row["url"]` from `row_to_work_item/1` — column doesn't exist. Read from `metadata["url"]` if present.
- [ ] Document expected schema in the adapter moduledoc; replace the stale "expected columns" list.

#### Adapter config: read vs writeback target

- [ ] Extend `tracker` config:
      ```yaml
      tracker:
        kind: database
        endpoint: "https://xyz.supabase.co/rest/v1"
        api_key: $SUPABASE_SERVICE_KEY
        table: work_items                   # read from here
        writeback:
          table: task                       # update state here
          id_field: task_id                 # FK on work_items pointing to write target
        comments_table: work_item_comments
        active_states: [todo, in_progress]
        terminal_states: [done, cancelled]
      ```
- [ ] Omitted `writeback` falls back to `table` (local-dev).
- [ ] `update_issue_state/2` resolves the write target: if `writeback.id_field` is set, `UPDATE task SET state=$new WHERE id=$work_item.task_id`. Error loudly if `task_id` is nil.

#### Comments

- [ ] Default `comments_table` → `"work_item_comments"` (singular — current default is wrong).
- [ ] Add `author` (configurable, default `"orchestrator"`) and `source: "orchestrator"` to every comment insert.

#### Tests

- [ ] Unit tests covering read/writeback split, error path when `task_id` is nil.
- [ ] Integration test against local Supabase or recorded HTTP fixture.

**Dependencies:** OR-1, PL-0. **Risk:** medium — silent data loss today.
**No orchestrator-repo migration required** — all changes are code-side.

---

### OR-4 — Launcher writes orchestrator lifecycle to `engine_instance`

Today the launcher's state is in-memory + a local JSON file at `~/.symphony/launcher`.
The platform has no DB-level view of what's running. `engine_instance` is the right
table — it already has every field we need.

`engine_instance` shape (for reference):
```
instance_id       (primary key; launcher-generated)
agent_id          → agent.id
workspace_id      → workspaces.id
host              (e.g. "127.0.0.1" or public hostname)
port              (the orchestrator's runtime port)
role              (e.g. "orchestrator"; leave room for other roles)
status            (starting, running, restarting, stopped, failed)
started_at
last_health_at
ws_connection_id  (nullable; set when a client connects via /ws)
updated_at
```

#### Tasks

- [ ] Add `SymphonyElixir.Launcher.EngineInstance` module with Supabase PostgREST client (reuse HTTP patterns from OR-3).
- [ ] On `POST /agents/:id/start` success: `INSERT INTO engine_instance` with `status='running'`, full host/port/role.
- [ ] On stop / graceful shutdown: `UPDATE engine_instance SET status='stopped'`.
- [ ] On crash / restart: `status='restarting'` → `'running'` transitions via the supervision callback.
- [ ] Heartbeat tick (every ~30s) updates `last_health_at`.
- [ ] On launcher boot, before restoring from local JSON: reconcile against `engine_instance` rows where `host = <my host>` — if a row says `running` but we don't have a supervised process for it, re-start it or mark it `failed`.
- [ ] Env gate: `LAUNCHER_SUPABASE_URL` + `LAUNCHER_SUPABASE_SERVICE_KEY`. Skip writeback when absent (local dev).
- [ ] Tests: mock Supabase client; assert status transitions across start, stop, crash, and double-start.

**Dependencies:** OR-3 (same Supabase HTTP client patterns). **Risk:** medium — first persistent Launcher→DB write.

---

### OR-5 — Launcher reads launch config from `gateway_config`; writes `gateway_config_state`

Today the launcher uses a launcher-owned base template and injects stored-agent
metadata under `config["stored_agent"]` ([db_agent_inventory.md:47](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/db_agent_inventory.md#L47)).
That's a short-term shim. The platform's intended config mechanism is `gateway_config`.

#### Design decision — scope

`gateway_config` is keyed by `(scope_type, scope_id)`. The column is plain `string` in the
schema (no enum constraint), so adding a new scope_type is a convention change, not a
migration. Existing rows all use `scope_type = 'user'` — we introduce two new values:

- `scope_type = 'agent'`, `scope_id = <agent.id>` — per-agent launch config (tracker, runners, workflow template, `max_concurrent_agents`). Primary resolution target.
- `scope_type = 'workspace'`, `scope_id = <workspace.id>` — workspace-wide defaults that agents inherit when no agent-scoped row exists. Optional; skip until needed.

Resolution order on launch: `('agent', agent_id)` → `('workspace', workspace_id)` → local launcher template (kept for local dev only). Document this order in the moduledoc so future readers don't have to reconstruct it from code.

#### Tasks

- [ ] Add `SymphonyElixir.Launcher.GatewayConfig` module: `fetch/2` by `(scope_type, scope_id)`, `record_apply_state/4` writing `gateway_config_state`.
- [ ] On `POST /agents/:id/start`:
      1. Resolve `workspace_id` from `agent` row.
      2. Fetch `gateway_config` for `('agent', agent_id)`; fall back to `('workspace', workspace_id)` if absent; fall back to the current local template only if both are missing (keep this for local dev).
      3. Merge fetched `config_json` into the launch config (tracker, runners, workflow template).
      4. After successful start: `UPSERT gateway_config_state` with `scope_type`, `scope_id`, `last_applied_hash`, `last_applied_version`, `last_apply_status='ok'`, `last_apply_at=now()`, `broker_instance_id=<engine_instance.instance_id>`.
      5. On apply failure: `last_apply_status='error'`, `last_apply_error=<message>`.
- [ ] Config hot-reload: on a `gateway_config` version bump (polled or pushed — decide), restart the orchestrator or reload config in place, and update `gateway_config_state` again.
- [ ] Integration test: seed `gateway_config` for an agent; call `POST /agents/:id/start`; assert orchestrator runs with the seeded tracker/runners and that `gateway_config_state` reflects the applied version.

**Dependencies:** OR-4 (needs `engine_instance.instance_id` to write `broker_instance_id`). **Risk:** medium — first read of a versioned DB-driven config.

---

### OR-6 — Orchestrator writes execution logs to `broker_run` / `broker_task`

Needed for a durable dashboard history and for the launcher to survive restarts without
losing which items have been processed.

#### Mapping

- **Run start** (orchestrator claims a work item): `INSERT broker_run` with `agent_id`, `workspace_id`, `issue_identifier`, `issue_state`, `tracker_kind`, `tracker_issue_key`, `status='started'`, `attempt`, `queued_at`, `started_at`, `input=<prompt_vars>`, `workspace_path`, optional `session_thread_id` + `codex_session_key` once known.
- **Per-turn** (each Codex `turn/*` cycle): `INSERT broker_task` with `run_id`, `type='turn'`, `input_tokens`, `output_tokens`, `total_tokens`, `last_event`, `lease_expires_at`.
- **Run end**: `UPDATE broker_run SET status=<completed|failed|cancelled>, completed_at, output, error, terminal_reason`.

#### Tasks

- [ ] `SymphonyElixir.BrokerLog` module wrapping Supabase writes; no-op when Supabase env vars absent.
- [ ] Hook into `AgentRunner` lifecycle (start, per-turn, end).
- [ ] Token accounting already exists ([token_accounting.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/token_accounting.md)) — wire it to `broker_task` row inserts.
- [ ] Reconcile on orchestrator startup: any `broker_run` rows in `status='started'` for this `engine_instance` that aren't actually running → mark `failed` with `terminal_reason='orphaned'`.
- [ ] Tests: mock Supabase; assert one `broker_run` + N `broker_task` rows per completed work item.

**Dependencies:** OR-4 (for `engine_instance.instance_id` linkage if we add one — currently `broker_run` doesn't have that FK; decide whether to add it or match on `agent_id` + `started_at`). **Risk:** medium — first durable execution log.

---

### OR-A — Prompt template variable rename (`issue` → `item`)

- [ ] Replace `{{ issue.* }}` with `{{ item.* }}` in `apps/orchestrator/lib/symphony_elixir/workflow/templates/`
- [ ] Keep `issue` as a deprecated alias for one release; log a deprecation warning
- [ ] Update [WORKFLOW.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/WORKFLOW.md) snippets

**Dependencies:** OR-1. **Risk:** low.

---

### OR-B — Update architecture doc endpoint naming

The cross-repo architecture doc still uses `/orchestrators`. The shipped endpoints are
`/agents/:id/start` and `/worker-bridge/*`. Rename everywhere so the platform team reads
the right contract.

- [ ] Replace `POST /orchestrators` with `POST /agents/:id/start` in [launcher-architecture-and-cross-repo-integration.md](./launcher-architecture-and-cross-repo-integration.md) (runtime repo has its own copy at `docs/architecture-launcher-integration.md` — update both)
- [ ] Replace `GET /orchestrators` → `GET /agents`, `GET /orchestrators/:id` → `GET /agents/:id`
- [ ] Add the `/worker-bridge/sessions` surface to the doc (currently only lives in `worker-bridge.md`)
- [ ] Clarify that the `POST /agents/:id/start` request body is *minimal* (just the agent id) because launch config comes from `gateway_config` (per OR-5), not inline.
- [ ] Add the `engine_instance`, `gateway_config`, `broker_run` mappings from this doc to the architecture doc's §Data model section

**Dependencies:** none (docs only). **Risk:** low.

---

## Platform PRs (API server + web client repo)

### PL-0 — Verify (or add) `task → work_items` projection trigger

Pre-req for OR-3. The orchestrator will update `task.state`; the next poll of
`work_items` must see the update.

- [ ] Inspect live Supabase: `SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgrelid IN ('task'::regclass, 'work_items'::regclass);`
- [ ] If missing or partial: add trigger on `task` (AFTER INSERT OR UPDATE) that upserts `work_items` via `_task_to_work_item_metadata`.
- [ ] Confirm reverse direction (work_items → task) is NOT triggered.
- [ ] Smoke test: `UPDATE task SET state='done' WHERE id=$1;` → `SELECT state FROM work_items WHERE task_id=$1;` returns `'done'`.

**Dependencies:** none. **Risk:** low if already exists.

---

### PL-1 — Launcher HTTP client (real endpoints)

Typed client in the API server repo hitting the actual shipped endpoints.

- [ ] Client module targeting `LAUNCHER_BASE_URL` with:
      - `GET /agents`, `GET /agents/:id`, `GET /agents/:id/credentials`
      - `POST /agents/:id/start`
      - `POST /worker-bridge/sessions`, `GET /worker-bridge/sessions[/:id]`, `DELETE /worker-bridge/sessions/:id`
      - `GET /health`
- [ ] Env: `LAUNCHER_BASE_URL` (default `http://127.0.0.1:4100`), `LAUNCHER_REQUEST_TIMEOUT_MS`
- [ ] Typed request/response models matching the shipped contracts (see [worker-bridge.md:52](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/worker-bridge.md#L52))
- [ ] Retry with bounded exponential backoff on 5xx / network error
- [ ] Error surface distinguishing 4xx (config) from 5xx (process)
- [ ] Unit tests against a mock launcher

**Dependencies:** none — contracts are already shipped. **Risk:** low.

---

### PL-2 — Runtime `/ws` and agent API proxy

The worker-bridge is **not** a chat transport. The browser talks to runtime `/ws`
through a platform-owned proxy. See [worker_bridge_and_websocket_architecture.md:90](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/worker_bridge_and_websocket_architecture.md#L90).

- [ ] Middleware resolving `(user_id, agent_id) → engine_instance` via `SELECT host, port FROM engine_instance WHERE agent_id=$1 AND status='running' ORDER BY started_at DESC LIMIT 1`.
- [ ] Proxy `GET /api/agents`, `GET /api/agents/:identifier`, `POST /api/agents/refresh`, `GET /health` to `http://{host}:{port}/api/v1/...`.
- [ ] **Websocket proxy** for `/ws` — pass `agent_id`, `workspace_id`, `session_key` query params through to the runtime (the runtime validates these as scope).
- [ ] Handle stale-port / engine-missing cases: look up via `GET /agents/:id` on the launcher to refresh, or re-query `engine_instance`.
- [ ] 503 with retriable hint when `engine_instance.status='starting'` or `'restarting'`.
- [ ] Integration test with real launcher + stub runtime.

**Dependencies:** PL-1, OR-4 (engine_instance seeded). **Risk:** medium — WS proxying is the failure mode for live chat.

---

### PL-3 — End-to-end setup flow (auth → agent create → gateway_config → start → MVP dashboard)

The user-facing story. After this ships, the demo works.

#### Auth (verify what exists)

- [ ] Supabase Auth wired in web client
- [ ] JWT forwarded to API server; middleware resolves `current_app_user_id()`
- [ ] RLS enforced via `is_workspace_member()` on all relevant tables

#### Agent creation (use existing `agent` table)

- [ ] Wizard collects: workspace selection (existing `workspaces`), agent name/slug, model settings, workflow template, repository URL, tracker choice + credentials, runners config
- [ ] On submit, API server:
      1. `INSERT INTO agent` with `workspace_id`, `created_by_user_id`, `model_settings`, `tool_policy`, `status='draft'`
      2. `INSERT INTO credential` rows for the provided API keys (Linear, Supabase, GitHub, etc.)
      3. `INSERT INTO gateway_config` with `(scope_type='agent', scope_id=<agent.id>)` and `config_json` containing the tracker/runners/workflow template
      4. `POST /agents/:id/start` to the launcher
      5. Poll `engine_instance` until `status='running'`, or stream via websocket
      6. Return agent id + engine info to the client

#### API server endpoints

- [ ] `POST /api/setup` — wraps the steps above
- [ ] `PUT /api/setup` — diff + new `gateway_config_versions` row; launcher hot-reloads or restarts per OR-5
- [ ] `GET /api/setup` — returns current `agent` + `engine_instance` + `gateway_config_state`
- [ ] Error envelope: launcher 4xx → API 400; launcher 5xx/unreachable → API 502 + mark `engine_instance.status='failed'` with reason

#### Web client wizard + MVP dashboard

- [ ] Wizard → `POST /api/setup` → poll `GET /api/setup` until running
- [ ] Surface launcher errors with actionable copy
- [ ] `/dashboard/:agent_id`:
      - `engine_instance.status` badge, host/port, uptime, `last_health_at`
      - Live agent list via `GET /api/agents` proxy
      - Chat panel connected to `/ws` (proxied) with runtime scope
      - Recent `broker_run` rows (if OR-6 is in) — skip cleanly if not
      - "Stop agent" button → `DELETE /worker-bridge/sessions/:id` or a dedicated stop call
      - Empty state for "no work items yet"

#### Tests

- [ ] E2E happy-path: seeded user → wizard with `tracker.kind='memory'` → `engine_instance.status='running'` → `/api/agents` 200 → `/ws` connects and echoes `hello-ok` → stop cleanly
- [ ] Unit tests for auth middleware, setup validation, error envelope

**Dependencies:** PL-1, PL-2, OR-4, OR-5. **Risk:** high — this is the integration PR.
**After this merges:** end-to-end demo works.

---

### PL-4 — Work-item ingest and normalization

External sources flow into `work_items` (and therefore `task` via the projection in PL-0).

- [ ] GitHub webhook → normalize issue/PR events into `task` (with the trigger populating `work_items`), `source='github'`
- [ ] Linear webhook or cron-poll → `source='linear'`
- [ ] `POST /api/work-items` → `source='api'` for manual entry
- [ ] Linear project backfill script
- [ ] RLS: agents only see `work_items` in their workspace
- [ ] Ensure every inserted `task` row produces a `work_items` projection with the fields OR-3 expects

**Dependencies:** OR-3, PL-0. **Risk:** medium — webhook normalization is edge-case-heavy.

---

### PL-5 — Dashboard polish (live updates, history, token usage)

- [ ] WS subscription streaming `broker_run` / `broker_task` updates (via PL-2 proxy into runtime `/ws` events, or via Supabase Realtime if broker_run is written by the orchestrator per OR-6)
- [ ] Retry / token-usage panel pulling from `broker_task` token columns
- [ ] Run history view per agent
- [ ] Surface `gateway_config_state.last_apply_status` as a config-sync badge (green = applied, amber = applying, red = error)

**Dependencies:** PL-2, OR-4, OR-5, OR-6.

---

## Suggested shipping order

### Phase 1 — MVP end-to-end

1. **PL-0** + **OR-1** + **OR-A** + **OR-B** in parallel — verifications and cleanup.
2. **OR-2** — adapter rename.
3. **OR-3** — Database tracker matches live schema; `task` as canonical writeback target.
4. **OR-4** — Launcher writes `engine_instance`.
5. **OR-5** — Launcher reads `gateway_config`.
6. **PL-1** → **PL-2** → **PL-3** — Launcher client, proxy, setup flow with MVP dashboard.

✅ **Demo works after PL-3 merges.** Logged-in user completes wizard → agent boots via launcher → dashboard shows `engine_instance` running and streams chat over runtime `/ws`.

### Phase 2 — production-grade

7. **OR-6** — `broker_run` / `broker_task` persisted execution log.
8. **PL-4** — external work-item ingest (GitHub, Linear webhook, direct API).
9. **PL-5** — dashboard polish, live history, token panels, config-sync badge.
