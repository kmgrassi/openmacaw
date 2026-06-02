# `task` Table Deprecation — PR Plan

Companion to [`oq-01-plan-format-pr-plan.md`](./oq-01-plan-format-pr-plan.md).
The OQ-01 work confirmed that `work_items` is the canonical
unit-of-work primitive going forward. This doc plans the
phased removal of the legacy `task` table.

## Why deprecate

`task` is a strict **subset** of `work_items`:

| Column | `task` | `work_items` |
|---|:-:|:-:|
| `id`, `created_at`, `updated_at`, `workspace_id`, `plan_id`, `description` | ✓ | ✓ |
| `name` (task) / `title` (work_items) | ✓ | ✓ |
| `status` (task) / `state` (work_items) | ✓ | ✓ |
| `priority` | – | ✓ |
| `labels` (text[]) | – | ✓ |
| `metadata` (jsonb) | – | ✓ |
| `identifier` (`WI-XXXXXX`) | – | ✓ |
| `source` (multi-origin marker) | – | ✓ |

Two tables holding the same conceptual entity, kept in lock-step
by bidirectional triggers (`sync_task_to_work_items` and
`sync_work_items_to_task`), is technical debt:

- **Drift risk on schema changes** — every new column has to be
  decided "task or work_items or both?" and the trigger updated.
- **Race conditions** — concurrent writes to both sides have
  produced ordering bugs in the past.
- **Cognitive load** — every reader has to know which table to
  use; new contributors guess wrong.
- **Sync loops** — bidirectional triggers on the same logical
  entity are fragile.

The user (internal-only at this stage —
[OQ-05 is deferred](./open-questions/deferred/oq-05-saas-posture.md))
has no external API consumers locked into `task`. Bounded migration cost.

## Current readers and writers (audit)

Found by grep against `main` of all three repos at scope-doc time.
Each has to be migrated before `task` can go.

### Platform (`parallel-agent-platform`)

| File | Lines | What it does |
|---|---|---|
| `apps/api/src/services/work-item-ingest.ts` | 7, 185 | `TaskRow = Tables<"task">` type alias + writes to `"task"` table via `upsertTaskFromNormalizedWorkItem`. The GitHub-issue ingest path. |
| `apps/api/src/services/planning-handoff.ts` | 61 | `supabaseSelect<"task", …>("task", taskParams)` — reads tasks for handoff. |
| `apps/web/src/api/plan-review.ts` | 12, 83 | `DbRow<"task">` type + `fromTable("task")` query. The plan-review UI. |

### Runtime (`parallel-agent-runtime`)

| File | What it does |
|---|---|
| `apps/orchestrator/lib/symphony_elixir/broker_log.ex` | Logs reference `task` |
| `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex` | `task.create`, `task.update`, `task.read` — being **removed** by OQ-01 PR 4 (the `create_plan` tool consolidation). After OQ-01 PR 4 lands, the runtime has no remaining `task` callers from the planner. |
| `apps/orchestrator/lib/symphony_elixir/tracker/database.ex` | Tracker reads/writes `task` for status reconciliation. |
| `apps/orchestrator/lib/symphony_elixir/supabase_schema.ex` | Auto-generated schema mirror. Will rebuild from new schema after the deprecation lands. |

### Migrations (`harper-server/supabase/migrations/`)

| File | Relationship |
|---|---|
| `20260113144416_add_task_and_plan_tables.sql` | Original `task` table. |
| `20260421120000_create_work_items_tables.sql` | `work_items` table + bidirectional sync triggers. |
| `20260424100000_add_workspace_id_to_plans_and_work_items.sql` | `workspace_id` added to both. |
| `20260303100300_create_broker_run_task.sql` | **Different table** (`broker_run_task`), not affected by this work. Confirmed by name; double-check the schema before assuming. |
| `20260408111000_add_symphony_orchestration_columns.sql` | Touches `task` columns; will need review during Phase 4 to confirm no orphaned references after migration. |

## Phased plan

Four PRs (Phase 1 = OQ-01 PR 1, already scheduled). Each phase is
reviewable, reversible, and lands on its own — no
all-or-nothing migration.

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
(OQ-01)    (migrate    (one-way    (migrate    (drop
 PR 1       readers)    sync)       writer)     table)
```

### Phase 1 (already scoped) — `work_items`-only fields

Lands in [OQ-01 PR 1](./oq-01-plan-format-pr-plan.md#pr-1--harper-server--migrations-extend-plan-and-work_items).
New columns (`instructions`, `depends_on`, `completion_gates`)
go on `work_items` and are not mirrored to `task`. This is the
first place we deliberately **don't** preserve symmetry. Done
to set the precedent.

### Phase 2 — Migrate `task` readers to read `work_items`

**Repos affected:** platform, runtime
**Branch (platform):** `feat/migrate-task-readers-platform`
**Branch (runtime):** `feat/migrate-task-readers-runtime`

**Scope (one PR per repo, no migration needed):**

Platform:
- `apps/api/src/services/planning-handoff.ts:61` — replace `supabaseSelect<"task", …>` with the equivalent `work_items` query joined on `task_id` (or directly, once we accept that every task has a `work_items` row by trigger).
- `apps/web/src/api/plan-review.ts:12,83` — replace `fromTable("task")` with `fromTable("work_items")`. Update `DbRow<"task">` consumers to `DbRow<"work_items">`. The UI fields (title, state) map directly.
- Update any TS types in `contracts/` that reference task-shape fields.

Runtime:
- `apps/orchestrator/lib/symphony_elixir/tracker/database.ex` — switch tracker reads from `task` to `work_items`.
- `apps/orchestrator/lib/symphony_elixir/broker_log.ex` — update log references.
- The planner-side reads (`task.read`) are removed by OQ-01 PR 4 — Phase 2 does **not** depend on OQ-01 PR 4 landing first, but it depends on OQ-01 PR 4 landing **before** Phase 3.

**CI guard added in this phase:**

A grep test (Vitest in platform, ExUnit in runtime) that fails if
any source file matches **any** of the call shapes that today
read from `task`. The audit found four distinct shapes in the
platform alone, so a single regex over `.from("task")` would
let three of them through. The guard runs each of these patterns
and fails the build on any match outside an allowlist
(`docs/`, the Phase-5 drop migration, the test fixtures).

**TypeScript patterns to ban (platform):**

| Pattern (regex) | Catches |
|---|---|
| `\.from\(["']task["']\)` | direct Supabase calls |
| `\bfromTable\(["']task["']\)` | the project's `fromTable` wrapper (e.g. `apps/web/src/api/plan-review.ts:83`) |
| `\bsupabaseSelect<["']task["']` | the project's `supabaseSelect` wrapper (e.g. `apps/api/src/services/planning-handoff.ts:61`) |
| `\bTables<["']task["']>` | type-alias references (`apps/api/src/services/work-item-ingest.ts:7`) |
| `\bDbRow<["']task["']>` | type-alias references (`apps/web/src/api/plan-review.ts:12`) |
| `\bTaskRow\b` (after rename) | the local alias once the type itself is removed; catches stragglers |

**Elixir patterns to ban (runtime):**

| Pattern (regex) | Catches |
|---|---|
| `@task_table\s*=\s*["']task["']` | the existing module attribute pattern (`planner/database_tools.ex`) |
| `"task"\s*,?\s*payload` | `create_row("task", …)` and friends |
| `from\(:task\b` | Ecto `from(:task in …)` |
| `from\(["']task["']` | string-keyed Ecto/Supabase calls |

The guard is a single test file per repo (e.g.
`apps/api/src/__tests__/no-task-reads.test.ts`) that loads each
project file, runs every pattern, and asserts zero matches
outside the allowlist. Add a new pattern to the test before
removing the corresponding writer so the guard is provably
working before it's relied on.

Land the guard *with* the migration PRs so future code can't
reintroduce direct or wrapped `task` reads. The allowlist also
narrows over time — once Phase 5 lands, the only `task`
references that should remain are in the migration drop file
itself and in this doc.

**Testing:**
- Each migrated reader gets a focused unit test asserting the new
  query returns equivalent shape.
- Integration test: planning-handoff returns same plan/task tree
  before and after the migration.

**Rollback:** trivial — revert the PR; the trigger still keeps
`task` populated.

### Phase 3 — Reverse the sync direction (one-way only)

**Repo:** `harper-server`
**Branch:** `migrations/task-deprecation-phase3-one-way-sync`
**Depends on:** Phase 2 complete (no readers of `task`).

**Scope:**
- New migration `<ts>_drop_sync_work_items_to_task.sql`:
  - Drop `sync_work_items_to_task` trigger (and the function it calls if not used elsewhere).
  - Keep `sync_task_to_work_items` so the legacy GitHub-issue ingest path still surfaces `work_items`.
- Add a `select 1` smoke-test migration that asserts `pg_trigger` no longer contains `sync_work_items_to_task` after apply.

**Testing:**
- Apply migration to a snapshot, then run the existing `work_item-ingest` test suite to confirm the ingest path still produces `work_items`.
- Manually update a `work_items` row and confirm `task` no longer changes (this is the desired behavior — `work_items` is now the canonical writer).

**Rollback:** re-apply the original trigger from
`20260421120000_create_work_items_tables.sql`. Document the
exact CREATE TRIGGER statement in the migration's down-migration
comment.

### Phase 4 — Migrate the GitHub-issue ingest path

**Repo:** platform
**Branch:** `feat/github-ingest-write-work-items-direct`
**Depends on:** Phase 3 complete.

**Scope:**
- Rewrite `apps/api/src/services/work-item-ingest.ts:185` to
  insert directly into `work_items` with `source = 'github'`,
  bypassing the `task` table.
- Set `work_items.task_id = null` on these new rows (no parallel
  `task` row exists for them).
- Remove the now-dead `TaskRow` type and the
  `upsertTaskFromNormalizedWorkItem` indirection.
- Migration: drop `sync_task_to_work_items` trigger after the
  code change ships. Land the trigger drop **after** the code
  change is verified in production for at least one deploy
  cycle so we can revert the code change without re-creating
  the trigger.

**Testing:**
- The existing `work-item-ingest.test.ts` suite — rewrite test
  setup to assert the ingest creates a `work_items` row with
  `source = 'github'`, `task_id = null`.
- Replay a captured GitHub `issues` and `pull_request` webhook
  payload through the new path; confirm the `work_items` shape
  matches what the trigger used to produce.

**Rollback:** revert the code change. Trigger is still in place
until the follow-on migration; rollback is safe.

### Phase 5 — Drop the `task` table

**Repo:** `harper-server`
**Branch:** `migrations/drop-task-table`
**Depends on:** Phase 4 complete + at least one full deploy
cycle of Phase 4 in production.

**Scope:**
- Pre-flight verification migration: `assert (select count(*) from task t left join work_items wi on wi.task_id = t.id where wi.id is null) = 0`. Fails the apply if any task row lacks a corresponding work_item.
- Drop the `task` table.
- Drop `work_items.task_id` (now meaningless without `task`).
- Drop any remaining triggers / functions tied to `task`.
- Update `apps/orchestrator/lib/symphony_elixir/supabase_schema.ex`
  in the runtime — regenerate from the new schema.

**Testing:**
- Pre-flight migration on a prod snapshot. If the assertion
  fails, do **not** drop — investigate the orphaned task rows.
- Post-drop: full integration suite green in both platform and
  runtime.

**Rollback:** harder than other phases. Once dropped, restoring
`task` requires a backup. Mitigation: take a verified Supabase
snapshot immediately before applying the drop. Document the
snapshot ID in the migration comment.

## Sequencing constraints (summary)

```
OQ-01 PR 1 ─────► OQ-01 PR 4 ─────► Phase 2 ─────► Phase 3 ─────► Phase 4 ─────► Phase 5
                  (planner          (audit         (reverse       (rewrite       (drop
                   tools)            readers)       sync)          ingest)        table)
```

OQ-01 PR 4 must land before Phase 2 completes (it removes the
planner's `task.*` tools, which are the runtime's primary
remaining `task` callers besides the tracker). The two efforts
can run in parallel up to Phase 2.

## Open questions

1. **Should `work_items.task_id` be retained as a soft-deletion
   audit marker?** (e.g., set to a sentinel UUID for "this came
   from a `task` row that's now gone".) Recommendation: no —
   drop the column with the table. The `metadata` jsonb already
   captures origin info via `source = 'github'` etc.

2. **Are there any RLS policies on `task` that need to be
   ported?** Depends on what's in the migrations directory we
   haven't fully audited. Phase 5 pre-flight should diff the
   `pg_policies` for `task` vs `work_items` and reconcile.

3. **External read consumers we don't know about?** With
   internal-only usage today this is a low risk, but a final
   audit before Phase 5 (look at any `/api/tasks` or similar
   API surface) is worth the 30 minutes.

## Cross-references

- [OQ-01 PR plan](./oq-01-plan-format-pr-plan.md) — Phase 1 lives there.
- [OQ-12 (Git/source-control)](./open-questions/oq-12-git-and-source-control.md) — discusses `work_items` as the unit the manager-agent reconciler reads from. The deprecation makes that contract clean.
