# Manager Agent — Implementation PR Plan

Sequenced PR plan for implementing `Runner.Manager` in this
repo. Companion to the design at
[`manager-agent.md`](./manager-agent.md).

The design doc is **already merged** (PRs #96, #97, #98), but
no code exists. This doc breaks the implementation into nine
reviewable PRs, ordered by dependency.

## What's actually built today

Audit against `apps/orchestrator/main` at scope-doc time:

| File | Status |
|---|---|
| `apps/orchestrator/lib/symphony_elixir/runner.ex` | Exists. Runner enum at `runner.ex:99-105` does NOT include `"manager"`. |
| `apps/orchestrator/lib/symphony_elixir/runner/manager.ex` | **Does not exist.** |
| `apps/orchestrator/lib/symphony_elixir/manager/` | Directory does not exist. |
| `apps/orchestrator/priv/prompts/manager-system-v1.md` | Does not exist (the `priv/prompts/` directory itself doesn't exist yet). |
| `apps/orchestrator/test/symphony_elixir/runner/manager_test.exs` | Does not exist. |
| `apps/orchestrator/lib/symphony_elixir.ex` | Top-level supervision tree. The Manager.Scheduler will be supervised here (one per workspace, dynamically). |
| `apps/orchestrator/lib/symphony_elixir/tracker/github.ex` | GitHub *issues* polling client. **Read-only.** Doesn't do PR operations (merge, comment, review fetch). The manager's GitHub adapter will be a sibling module, not an extension of this one. |

Cross-repo prerequisites:

| Prerequisite | Status |
|---|---|
| `event_log` table (OQ-12) | **Not migrated.** The `read_recent_events` tool reads from this. PR 1 below adds it. |
| `next_poll_at`, `last_polled_at`, `poll_cadence_seconds`, `manager_runner_id` columns on `work_items` (OQ-12) | **Not migrated.** PR 1 below adds them. |
| `escalation` table (OQ-08) | **Not migrated.** The `escalate_to_human` tool needs this. PR 6 below either depends on it landing first or stubs the write — open question flagged. |
| Workspace-creation hook auto-provisions manager (OQ-12 / PR #99 design) | **Designed, not implemented.** PR 8 wires the runtime side. |

## Sequencing diagram

```
PR 1 (harper-server migrations) ─┐
                                 │
                                 ├─► PR 3 ─► PR 4 ─► PR 5 ─► PR 6 ─► PR 7 ─► PR 8 ─► PR 9
                                 │   (runner   (sched-  (local   (dispatch  (GitHub  (super-  (end-
                                 │    module +  uler)    tools)   + escal-   adapter) vision)  to-end
                                 │    enum)                       ate)                          test)
PR 2 (tool specs + prompt) ──────┘
```

Both PR 1 (database migrations) and PR 2 (pure data files) are
independent of each other and can land in either order or in
parallel. PR 3 is the first PR that needs both — the runner
module imports the tool specs (PR 2) and depends on the runtime
having access to the new schema columns (PR 1) for any future
DB queries it adds.

PR 1 unblocks everything. PR 2 is independent of the migration
(pure data files); can land in parallel. After PR 3 the rest is
linear because each PR materially extends what `run_turn` and
`Scheduler.tick` can do.

## PR plan

### PR 1 — `harper-server` migration: `event_log` + `escalation` + `work_items` columns

**Repo:** `harper-server`
**Branch:** `migrations/manager-agent-prereq-tables`
**Depends on:** none.

**Why both tables in one PR:** confirmed via audit of `harper-server/main` — neither `event_log` nor `escalation` exists today. The closest matches are `notification_events` (outbound notification telemetry — wrong concern) and `broker_run` / `broker_task` (OpenClaw job mirror — wrong concern). Both manager prerequisites are net-new, and PR 6 of this plan needs the escalation table for its `escalate_to_human` tool. Bundling avoids a "PR 1.5 dependency on a separate OQ-08 migration" — see open implementation question #1, now resolved in favor of "depend, not stub."

**Scope:** new migration `<YYYYMMDDHHMMSS>_manager_agent_prereq_tables.sql`. Concrete SQL below.

#### 1. `public.event_log`

OQ-12's Layer-1 destination: webhook handlers append, manager's `read_recent_events` reads.

```sql
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.event_log (
  id            uuid primary key default gen_random_uuid(),
  work_item_id  uuid not null references public.work_items(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  source        text not null,             -- 'github_webhook' | 'mcp' | 'manual' | 'system'
  kind          text not null,             -- e.g. 'pull_request_review.submitted', 'check_run.completed'
  payload       jsonb not null default '{}'::jsonb,        -- normalized event data
  raw_payload   jsonb,                                      -- original webhook body, for debug/replay
  created_at    timestamptz not null default now()
);

comment on table public.event_log is
  'Append-only log of inbound events tied to a work_item. Webhook handlers and other Layer-1 ingest paths write here; the manager-agent''s read_recent_events tool reads.';
comment on column public.event_log.source is
  'Where the event came from. Lowercase snake_case.';
comment on column public.event_log.kind is
  'Event kind/type within the source. For GitHub webhooks, mirror the X-GitHub-Event + action shape (e.g., "pull_request_review.submitted").';
comment on column public.event_log.payload is
  'Normalized, runtime-friendly shape of the event. Schemas per (source, kind) live in code; this column does not enforce them.';
comment on column public.event_log.raw_payload is
  'Optional original webhook body for debug/replay. May be omitted to save storage on high-volume sources.';

-- Hot path for read_recent_events(work_item_id, since):
create index if not exists idx_event_log_work_item_created
  on public.event_log (work_item_id, created_at desc);

-- Analytics path (e.g. "how many review_comment events did we get this week"):
create index if not exists idx_event_log_source_kind_created
  on public.event_log (source, kind, created_at desc);
```

**Workspace_id is denormalized** (also derivable via `work_items` FK). Worth the redundancy: it makes the RLS policy a single index lookup rather than a join, and `event_log` is the highest-volume table the manager reads.

RLS:

```sql
alter table public.event_log enable row level security;

-- SELECT: workspace members.
create policy event_log_select_if_workspace_member
on public.event_log
for select
to authenticated
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = event_log.workspace_id
      and wm.user_id = public.current_app_user_id()
  )
);

-- INSERT/UPDATE/DELETE: no permissive policies for `authenticated`.
-- Append-only via service role from the webhook handler.
```

#### 2. `public.escalation`

OQ-08's first-class entity for human-in-the-loop interactions. Written by `escalate_to_human` tool calls (from any agent — manager, author, reviewer); read by the dashboard's escalation queue.

```sql
create table if not exists public.escalation (
  id                uuid primary key default gen_random_uuid(),
  work_item_id      uuid not null references public.work_items(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,

  -- Who/what fired the escalation
  triggered_by      text not null check (triggered_by in
                      ('manager', 'author', 'reviewer', 'system')),
  trigger_kind      text not null check (trigger_kind in
                      ('structural', 'self_flagged', 'resource', 'gate_failure')),
  reason_kind       text,                                       -- finer-grained tag from OQ-06's escalate_to_human tool:
                                                                -- 'ambiguous_intent' | 'missing_context' | 'policy_uncertain' |
                                                                -- 'destructive_action_unverified' | 'out_of_scope' |
                                                                -- 'stuck_after_retries' | 'other' | NULL for non-self-flagged
  triggered_at      timestamptz not null default now(),
  payload           jsonb not null default '{}'::jsonb,         -- question text, context_summary, candidate_options[], etc.

  -- Human response (NULL until responded)
  responded_at      timestamptz,
  response_kind     text check (response_kind is null or response_kind in
                      ('decision', 'reply', 'patch', 'approve', 'abandon', 'auto_abandoned')),
  response_payload  jsonb,
  responded_by      uuid references public."user"(id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.escalation is
  'First-class human-in-the-loop interactions. Written by escalate_to_human tool calls; read by the dashboard escalation queue. One row per escalation event; multiple per work_item is normal.';
comment on column public.escalation.triggered_by is
  'Which agent role fired the escalation. ''system'' covers orchestrator-side conditions like resource caps.';
comment on column public.escalation.trigger_kind is
  'Top-level OQ-06 trigger category. Pairs with reason_kind for finer-grained classification.';
comment on column public.escalation.payload is
  'Per OQ-06 escalate_to_human tool schema: { question, context_summary, candidate_options, preferred_option_id, urgency }.';
comment on column public.escalation.response_kind is
  '''auto_abandoned'' is set by the stale-escalation timeout job (default 7d) per OQ-06 delivery.stale_after_days.';

-- Outstanding queue (dashboard "what needs me?" view):
create index if not exists idx_escalation_outstanding
  on public.escalation (workspace_id, triggered_at desc)
  where responded_at is null;

-- Per-work-item history view:
create index if not exists idx_escalation_work_item_triggered
  on public.escalation (work_item_id, triggered_at desc);

-- Stale-escalation sweep:
create index if not exists idx_escalation_stale_sweep
  on public.escalation (triggered_at)
  where responded_at is null;

-- updated_at trigger (matches the agent_default_assignment pattern):
create or replace function public.tg_set_updated_at_escalation()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_escalation_updated_at on public.escalation;
create trigger trg_escalation_updated_at
before update on public.escalation
for each row execute function public.tg_set_updated_at_escalation();

-- Defense: workspace_id must match the parent work_item's workspace_id.
create or replace function public.tg_validate_escalation_workspace()
returns trigger language plpgsql as $$
declare
  v_wi_workspace_id uuid;
begin
  select workspace_id into v_wi_workspace_id
    from public.work_items
    where id = new.work_item_id;

  if v_wi_workspace_id is null then
    raise exception 'escalation: parent work_item % not found', new.work_item_id;
  end if;

  if v_wi_workspace_id <> new.workspace_id then
    raise exception 'escalation: workspace_id % does not match work_item workspace_id %',
      new.workspace_id, v_wi_workspace_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_escalation_workspace on public.escalation;
create trigger trg_validate_escalation_workspace
before insert or update on public.escalation
for each row execute function public.tg_validate_escalation_workspace();
```

RLS:

```sql
alter table public.escalation enable row level security;

-- SELECT: workspace members.
create policy escalation_select_if_workspace_member
on public.escalation
for select
to authenticated
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = escalation.workspace_id
      and wm.user_id = public.current_app_user_id()
  )
);

-- UPDATE: workspace members may record their response.
-- The dashboard sets responded_at, response_kind, response_payload, responded_by.
-- Trigger / app code enforces that responded_by = the acting user; we don't
-- duplicate that as a CHECK because the column is also nullable and set by
-- service role on auto_abandoned.
create policy escalation_update_if_workspace_member
on public.escalation
for update
to authenticated
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = escalation.workspace_id
      and wm.user_id = public.current_app_user_id()
  )
)
with check (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = escalation.workspace_id
      and wm.user_id = public.current_app_user_id()
  )
);

-- INSERT/DELETE: no permissive policies for `authenticated`.
-- Inserts come from agent runtimes via service role.
-- Deletes are not exposed; escalations are permanent records.
```

#### 3. Columns on `public.work_items`

The manager scheduler reads these on every tick.

```sql
alter table public.work_items
  add column if not exists next_poll_at         timestamptz,
  add column if not exists last_polled_at       timestamptz,
  add column if not exists poll_cadence_seconds int  not null default 300
    check (poll_cadence_seconds >= 10 and poll_cadence_seconds <= 86400),
  add column if not exists manager_runner_id    uuid;            -- nullable; soft pointer at the in-flight manager session

comment on column public.work_items.next_poll_at is
  'When the manager-agent scheduler should next consider this work_item. NULL = not currently scheduled (e.g. work_item is in a terminal state). Bumped to now() by Layer-1 webhook handlers on interesting events.';
comment on column public.work_items.last_polled_at is
  'When the manager last processed this work_item. Used for stuck-task detection (no progress in K consecutive polls).';
comment on column public.work_items.poll_cadence_seconds is
  'Per-work-item cadence override. Default 300 (5min). Bounded 10s..24h.';
comment on column public.work_items.manager_runner_id is
  'Soft pointer at the manager runner session currently working this item; informational only, not enforced.';

-- Hot path for the scheduler's due-batch query (per the manager-agent.md design):
--   where workspace_id = ?
--   where state in (...)
--   where next_poll_at is null or next_poll_at <= now()
create index if not exists idx_work_items_due_for_manager
  on public.work_items (workspace_id, state, next_poll_at)
  where next_poll_at is not null;
```

The partial index excludes rows with `next_poll_at IS NULL` because the scheduler treats NULL as "not currently scheduled" — those rows should not be in the due-batch result set.

#### Out of scope (deferred)

- The `mention_handler` table from OQ-12. `@harper-claude` mention handling is a follow-on after the manager works. Manager core has no dependency on it.
- The `routing_rule` table from OQ-03. Read from `gateway_config.config_json.routing` for the manager dispatch path; migrate when OQ-03 lands. (See open question #2 below.)
- The `auto_merge_policy` table from OQ-07. Same approach — read from `gateway_config.config_json.auto_merge` for the `merge_pr` tool; migrate when OQ-07 lands.

#### Testing

- Migration applies cleanly to a snapshot of prod-shape data.
- `event_log`: cross-workspace SELECT is denied by RLS (workspace member of A can't read B's events).
- `event_log`: insert with non-existent `work_item_id` fails the FK; insert with mismatched `workspace_id` (vs the parent work_item) is allowed at the SQL level (we don't add a denormalization-check trigger here — the writer is service-role and can self-validate). Document this trade-off in the migration comments if desired.
- `escalation`: cross-workspace SELECT denied. Workspace-mismatch trigger fires on INSERT and UPDATE.
- `escalation`: workspace member can UPDATE response columns; non-member can't.
- `work_items`: existing rows are unaffected (`next_poll_at` defaults to NULL); partial index doesn't pick them up.
- `work_items.poll_cadence_seconds` boundary: insert with 5 fails the CHECK; with 86_401 fails; with 300 passes.

### PR 2 — Tool specs + system prompt (pure data)

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/manager-tool-specs`
**Depends on:** none (pure data files).

**Scope:**

- New `apps/orchestrator/lib/symphony_elixir/manager/tools.ex`:
  - `tool_specs/0` returning the eight tool definitions per `manager-agent.md`. **Definitions only — no `execute/3` implementations yet.** Each spec uses the `inputSchema` field shape (matching `database_tools.ex:96, 112, 130, 264`).
  - The eight tools: `read_artifact_state`, `read_recent_events`, `dispatch_runner`, `merge_pr`, `post_comment`, `escalate_to_human`, `snooze`, `mark_done`.
- New `apps/orchestrator/priv/prompts/manager-system-v1.md` containing the v1 system prompt. Markdown-shaped so future versions can be diffed cleanly.
- New `apps/orchestrator/lib/symphony_elixir/manager/prompt.ex`:
  - `version/0 :: "v1"`.
  - `load!/0 :: String.t()` — reads `priv/prompts/manager-system-#{version()}.md` at boot and caches.

**Testing:**
- ExUnit: `tool_specs/0` returns exactly 8 specs with non-empty `name`, `description`, `inputSchema`.
- ExUnit: `Manager.Prompt.load!/0` returns non-empty content; version constant matches the file name.
- Schema parity test (deferred to PR 3, since there's no JSON Schema source-of-truth yet for the manager tools — same drift-prevention pattern as the planner has, but lower priority since the manager isn't cross-repo like `create_plan` is).

### PR 3 — Manager runner module + enum wiring

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/manager-runner-module`
**Depends on:** PR 2 (tool specs + prompt).

**Scope:**

- New `apps/orchestrator/lib/symphony_elixir/runner/manager.ex` implementing the `Runner` behavior:
  - `requires_workspace?/0 :: false` — no repo clone needed.
  - `start_session/2`: returns a session struct `%{model, credential_id, workspace_id, prompt: Prompt.load!()}`. Resolves credential via `Credentials.resolve(...)` (per OQ-04). Stateless across ticks otherwise.
  - `stop_session/1 :: :ok` — no-op.
  - `ping/1`: returns `:ok` if the credential resolves; `{:error, :no_credential}` if not.
  - `run_turn/3`: dispatches to OpenAI Responses API (mirroring `planner.ex` at `runner/planner.ex:16`'s `@responses_url`) with the system prompt, the `due_tasks` payload, and the eight tool specs. Loops on tool calls. **For PR 3, every tool's `execute/3` returns `{:error, :not_implemented}`** — the runner module is wired up but real tool execution lands in PR 5–7.
- Update `apps/orchestrator/lib/symphony_elixir/runner.ex` enum at lines 99-105: add `"manager" -> SymphonyElixir.Runner.Manager`.

**Testing:**
- ExUnit: `Runner.Manager` conforms to `SymphonyElixir.Runner` behavior (compile-time assertion + runtime callback presence).
- ExUnit with a mock Responses-API client: `run_turn/3` produces the expected tool-call loop shape; `:not_implemented` errors are captured and reported in the result; the runner doesn't crash on tool errors.

### PR 4 — Scheduler GenServer

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/manager-scheduler-genserver`
**Depends on:** PR 1 (column existence), PR 3 (a runner to dispatch through).

**Scope:**

- New `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`:
  - GenServer, one per workspace.
  - `start_link(workspace_id)` registers under `{:via, Registry, ...}` so other code can look up a workspace's scheduler.
  - `init/1`: schedules the first tick after a small jitter (avoid all schedulers ticking simultaneously on orchestrator restart).
  - `handle_info(:tick, state)`:
    - Queries due work_items using the **multi-`where` form** (per the precedence-bug fix from the design-review). Each filter is its own `where` clause; Ecto AND's them implicitly:
      ```elixir
      from wi in WorkItem,
        where: wi.workspace_id == ^state.workspace_id,
        where: wi.state in [:running, :awaiting_review],
        where: not is_nil(wi.next_poll_at),
        where: wi.next_poll_at <= ^now(),
        order_by: [asc: wi.next_poll_at]
      ```
      **Note the `not is_nil` filter.** `next_poll_at IS NULL` means
      "not currently scheduled for the manager" — the work_item exists
      but the manager shouldn't be reconciling it yet. The earlier draft
      treated NULL as immediately-due, which conflicted with the partial
      index in PR 1 (`where next_poll_at is not null`) and would
      reprocess every NULL row on every tick, defeating cadence control.
      This filter aligns the query with the partial index — the planner
      can use the index, and unscheduled rows stay quiescent.

      The platform side is responsible for **bumping `next_poll_at = now()`**
      when a work_item should enter the manager's purview (workspace
      creation hook, work_item ingest, "interesting" webhook events
      per OQ-12 Layer 1). Until that bump happens, NULL means "leave
      it alone."
    - If due batch is non-empty, calls `Manager.run_batch(state.session, due_work_items)`.
    - Schedules next tick after `state.min_cadence_ms`.
  - Default `min_cadence_ms = 60_000`. Configurable via `gateway_config.config_json.runners.manager.min_cadence_ms`.
- New `apps/orchestrator/lib/symphony_elixir/manager.ex` with `run_batch/2` orchestrating one `run_turn/3` call per batch.

**Testing:**
- ExUnit: scheduler ticks at the configured cadence; tick-gap respects jitter.
- ExUnit: due-items query returns only matching workspace + state + time; mismatched workspace's overdue items don't leak (regression test for the Codex-flagged precedence bug).
- ExUnit: a row with `next_poll_at = NULL` is **NOT** picked up — must remain quiescent until something explicitly bumps it. (Regression test for the NULL-semantics fix.)
- ExUnit: a row with `next_poll_at <= now()` IS picked up; one with `next_poll_at = now() + 5s` is NOT.
- ExUnit: empty batch is a no-op.

### PR 5 — Local-only tool execute/3 implementations

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/manager-tools-local`
**Depends on:** PR 4 (scheduler + run_turn loop).

**Scope:**

Implement `execute/3` for the four tools that don't need external APIs:

- `snooze(work_item_id, seconds)`: updates `work_items.next_poll_at = now() + seconds`. Bounded — refuse seconds > 24h, refuse seconds < 10. Returns `{:ok, %{next_poll_at}}`.
- `mark_done(work_item_id)`: sets `work_items.state = "done"`, `next_poll_at = NULL`. Idempotent on already-done. Returns `{:ok, %{state}}`.
- `read_recent_events(work_item_id, since)`: queries `event_log` rows where `work_item_id = ? and created_at >= since`, ordered by `created_at`. Returns list of normalized `%{kind, source, summary, created_at}` maps. **Trims long payloads** to summary strings — the manager prompt expects a summary view, not raw payloads.
- `read_artifact_state(work_item_id)`: routes by `work_item.kind` (per the design's per-vertical adapter dispatch). For PR 5, the only branch implemented is `"code"` → returns `{:error, :not_implemented_yet, "implement in PR 7"}`. Non-code kinds return `{:error, :unsupported_kind}`. The dispatch shape is wired here so PR 7 just slots in the GitHub adapter.

**Testing:**
- ExUnit per tool with fixture data.
- ExUnit: integration through `run_turn/3` — manager LLM (mocked) emits a `snooze` call; tool executes; the work_item's `next_poll_at` reflects the change; the next scheduler tick correctly skips that work_item until the snooze elapses.

### PR 6 — `dispatch_runner` + `escalate_to_human`

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/manager-tools-dispatch-escalate`
**Depends on:** PR 5 (other tools landed; full tool-execute machinery in place).

**Scope:**

- `dispatch_runner(work_item_id, runner_kind, intent, context)` `execute/3`:
  - Looks up the routing rule for `(workspace_id, runner_kind)`. Currently this means reading `gateway_config.config_json.routing` (OQ-03's relational `routing_rule` table doesn't exist yet — see open question #2).
  - Resolves the credential per OQ-04.
  - Calls into the existing runner-dispatch infrastructure (the same path the orchestrator uses today to spin up Codex / OpenClaw / etc. for a work_item).
  - Idempotency: checks for an in-flight runner of the same `(work_item_id, runner_kind, intent)` and short-circuits if one exists. Stores in `work_item.metadata.in_flight_dispatches` jsonb.
  - Returns `{:ok, %{runner_session_id}}` or `{:error, ...}`.
- `escalate_to_human(work_item_id, ...)` `execute/3`:
  - Writes a row to the `escalation` table (OQ-08) capturing `triggered_by: "manager"`, `reason_kind` (e.g. `stuck_after_retries`, `resource_cap_hit`), `payload`.
  - Updates `work_item.state = "escalated"`.
  - **Open question (see #1 below):** the `escalation` table doesn't exist yet. This PR either depends on an OQ-08 migration landing first, or includes a stub that just sets `work_item.state = "escalated"` and logs (and writes a follow-up TODO).

**Testing:**
- ExUnit: `dispatch_runner` idempotency — two consecutive dispatches of the same `(work_item_id, runner_kind, intent)` produce one runner session, not two.
- ExUnit: `escalate_to_human` transitions state and writes the escalation row (or stub).
- Integration: manager LLM (mocked) emits `dispatch_runner` for a code task → a real Codex session starts (against a mock Codex backend).

### PR 7 — GitHub artifact-state adapter + `read_artifact_state` / `merge_pr` / `post_comment`

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/manager-github-artifact-state`
**Depends on:** PR 6 (full local-tool surface).

**Scope:**

- New `apps/orchestrator/lib/symphony_elixir/manager/artifact_state/github.ex`:
  - Sibling to `tracker/github.ex` (whose existing GitHub client surface is read-only and issues-focused — not enough). Reuses the workspace's `github_app_install` credential (existing pattern).
  - `read/1 :: WorkItem.t() -> {:ok, %{summary: String.t(), full: map()}}`. Fetches the PR's status, requested reviewers, latest review verdicts, check_run results, recent comments. Returns a compact summary string for the manager prompt + the full structured payload for downstream tool calls.
  - Caches per `(work_item_id, etag)` for ~30s — consecutive ticks shouldn't re-hit GitHub.
- Wire `read_artifact_state` to dispatch to `Manager.ArtifactState.GitHub` for `work_item.kind == "code"`.
- `merge_pr(work_item_id)` `execute/3`: respects `auto_merge_policy` (OQ-07 — see open question #3 about whether that table exists yet). Calls GitHub's merge API. Returns the merge SHA. Idempotent on already-merged.
- `post_comment(work_item_id, body)` `execute/3`: posts a comment on the work_item's PR. Returns the comment URL.

**Testing:**
- ExUnit with a fixture GitHub API responder (HTTP-level fixtures).
- Integration: full tick loop — manager reads state, dispatches a runner, runner pushes a commit, manager re-reads state on next tick and sees the new commit reflected.
- Cache test: two `read_artifact_state` calls within 30s produce one HTTP request.

### PR 8 — Workspace-bootstrap supervision wiring

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/manager-supervision-bootstrap`
**Depends on:** PR 7 (a fully functional manager).

**Scope:**

- New `apps/orchestrator/lib/symphony_elixir/manager/supervisor.ex` — `DynamicSupervisor` that hosts per-workspace `Manager.Scheduler` GenServers. Added to the top-level supervision tree in `apps/orchestrator/lib/symphony_elixir.ex`.
- Workspace-created event handler: subscribes to whatever event the platform fires when a new workspace is provisioned (per PR #99 design). On event, ensures a `Manager.Scheduler` is running for the workspace under `Manager.Supervisor`.
- Orchestrator-startup sweep: on `Application.start`, queries all active workspaces and ensures a scheduler is running for each. Idempotent — re-binding to an existing one is a no-op.
- Workspace-archived handler: gracefully stops the scheduler.

**Testing:**
- ExUnit: starting `Manager.Supervisor` with two workspaces in the DB results in two schedulers running; killing one auto-restarts via `:transient` strategy.
- ExUnit: a synthetic workspace-archived event stops the corresponding scheduler.

### PR 9 — End-to-end integration test

**Repo:** `parallel-agent-runtime`
**Branch:** `test/manager-end-to-end`
**Depends on:** PR 8 (full system wired up).

**Scope:**

A single integration test that:
1. Creates a synthetic workspace with `gateway_config.config_json.runners.manager` populated and a credential.
2. Inserts a `work_items` row with `state = "running"`, `next_poll_at = now()`, `kind = "code"`, and a synthetic PR URL.
3. Stubs the GitHub API to return a "review request_changes" payload.
4. Triggers a scheduler tick.
5. Asserts the manager LLM (mocked, returning a deterministic `dispatch_runner(intent: "address_review")` tool call) emits the right call.
6. Asserts a Codex runner session starts for the work_item.
7. Asserts no `agent_default_assignment` row was written for the manager (the contract from PR #99 / #98).

This is the slow test — runs in CI against the full app supervision tree. Marked `@tag :integration` so it can be opted out of by `mix test --exclude integration`.

## Open implementation questions

### 1. ✅ Resolved — `escalation` table is bundled into PR 1

After auditing `harper-server/main`: neither `event_log` nor `escalation` exists today, and there's no in-flight OQ-08 migration to wait for. Bundling both tables into PR 1 (along with the `work_items` columns) removes the "PR 1.5" dependency entirely and lets PR 6's `escalate_to_human` write to a real table on day one. **No stubs.** See PR 1's expanded scope above for the full SQL.

### 2. Does the relational `routing_rule` table from OQ-03 exist when PR 6 lands?

OQ-03's design pulls routing rules out of `gateway_config.config_json.routing` into a relational `routing_rule` table. As of scope-doc, that migration also doesn't exist.

For the manager's `dispatch_runner`, this is less critical — we can read `gateway_config.config_json.routing` for now, and migrate to the relational table when OQ-03 lands. The runner-dispatch lookup function should be the abstraction point (Single Responsibility — it doesn't matter to the manager whether routing is jsonb or relational).

**Recommendation:** Read from `gateway_config.config_json.routing` in PR 6. When OQ-03 migrates the data, change the lookup function in one place.

### 3. Auto-merge policy enforcement in `merge_pr`

PR 7's `merge_pr` should respect `auto_merge_policy` (OQ-07). That policy table also doesn't exist yet. **Recommendation:** PR 7's `merge_pr` checks `gateway_config.config_json.auto_merge` (the same source-of-truth pattern). When OQ-07's relational table lands, the read shifts.

### 4. LLM-call abstraction

The planner (`runner/planner.ex:16`) calls the OpenAI Responses API directly with `@responses_url`. The manager will do the same in PR 3 — direct call, no shared abstraction. Worth flagging as a refactor candidate (manager + planner + future runners would all benefit from a shared `LLMClient` module), but **out of scope** for this plan. Not blocking.

### 5. Status reporting — `GET /api/runtime/manager-status`

The platform-side onboarding doc (PR #111) references this new endpoint. The runtime side has to expose it. Suggested location: a thin endpoint on the existing launcher router (`launcher/router.ex`) that asks `Manager.Supervisor` for the requested workspace's scheduler, returns `{status, last_tick_at, last_decision_count}`. Add this in PR 8 alongside the supervision wiring.

## Cross-references

- Design doc: [`apps/orchestrator/docs/manager-agent.md`](./manager-agent.md)
- Bootstrap design (auto-create on workspace creation): [#99](https://github.com/kmgrassi/parallel-agent-runtime/pull/99) (open) and the merged predecessors [#96](https://github.com/kmgrassi/parallel-agent-runtime/pull/96), [#97](https://github.com/kmgrassi/parallel-agent-runtime/pull/97), [#98](https://github.com/kmgrassi/parallel-agent-runtime/pull/98)
- Platform-side companion (UX + API contract): [`parallel-agent-platform/docs/manager-agent-onboarding.md`](../../../parallel-agent-platform/docs/manager-agent-onboarding.md) (PR #111)
- The `Runner` behavior contract this implements: `apps/orchestrator/lib/symphony_elixir/runner.ex:54-89`
- Existing reference runners alongside the manager: `apps/orchestrator/lib/symphony_elixir/runner/{codex,planner,openclaw,computer_use,mock}.ex`
- Existing GitHub client (read-only, issues-focused — not the manager's PR client): `apps/orchestrator/lib/symphony_elixir/tracker/github.ex`
- OQ-12 (canonical decision): `parallel-agent-platform/docs/open-questions/oq-12-git-and-source-control.md`
- OQ-04 (credential resolution): `parallel-agent-platform/docs/open-questions/oq-04-per-task-model-overrides-credentials.md`
- OQ-06 (escalation policy): `parallel-agent-platform/docs/open-questions/oq-06-escalation-policy-schema.md`
- OQ-07 (auto-merge gates): `parallel-agent-platform/docs/open-questions/oq-07-auto-merge-gate-selection.md`

## Out of scope for this plan

- Per-vertical artifact-state adapters beyond GitHub (Figma, DaVinci, etc.). Deferred per OQ-09 / OQ-10.
- The `mention_handler` table from OQ-12 — `@harper-claude` mention handling is a follow-on after the manager works.
- Refactoring the LLM-call surface into a shared `LLMClient` module.
- The platform-side `GET /api/runtime/manager-status` endpoint definition (lives on the platform side).
- Workspace-creation hook on the platform side that auto-provisions the manager (lives in PR #99 / #111 work).
