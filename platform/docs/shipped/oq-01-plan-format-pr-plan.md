# OQ-01 Plan Format — Implementation PR Plan

Implementation scope for [OQ-01: Plan format](./open-questions/oq-01-plan-format.md).
This doc is the canonical source for the work — migrations land
in `harper-server`, schema + API + UI in `parallel-agent-platform`,
planner-tool changes in `parallel-agent-runtime`. PR descriptions
in those repos should link back here.

## What was decided (recap)

- **Hybrid plan format.** NL is the default user surface; structured
  JSON is the canonical storage shape; YAML export is for power
  users (deferred). No DSL.
- **One source-of-truth JSON Schema** (`packages/plan-schema/v1.json`)
  consumed by:
  1. The planning-agent's `create_plan` function-call schema
  2. `POST /api/plans` request validation
  3. The dashboard plan editor (form generated from schema)
  4. (deferred) `harper-cli plan push` client-side validation
- **Single canonical tool.** The planning agent talks to *one*
  tool — `create_plan` — whose input schema **is** the plan
  schema. No text-to-JSON parsing; no separate `plan.create` +
  N×`task.create` round-trips.

## Current state — what exists today

Audit conducted against `main` of all three repos at the time of
writing.

### Database (`harper-server/supabase/migrations/`)

| Table | Status | Notes |
|---|---|---|
| `plan` | Exists | Created in `20260113144416_add_task_and_plan_tables.sql`. Columns: `id, created_at, updated_at, name, description, message_id, status`. Extended with `workspace_id` in `20260424100000_add_workspace_id_to_plans_and_work_items.sql`. **No `metadata` jsonb, no `schema_version`, no `intent`, no `default_runner_kind`, no `default_model`.** |
| `task` | Exists | Created in same migration. Columns: `id, name, description, status, plan_id, workspace_id, …`. **No `instructions`, `depends_on`, `completion_gates`, `labels`** — `task.metadata` jsonb absent. |
| `work_items` | Exists | Created in `20260421120000_create_work_items_tables.sql`. Columns: `id, identifier, title, description, state, priority, labels (text[]), source, metadata (jsonb), task_id, plan_id, …`. Bidirectionally synced with `task` via triggers `sync_task_to_work_items` and `sync_work_items_to_task`. Already has `metadata` jsonb and `labels` text[]. **Missing `instructions` (distinct from `description`), `depends_on`, `completion_gates`.** |
| `planning_profile` | Exists | Rich (`instructions`, `definition_of_done`, `validation_commands`, `repo_boundaries`, `security_constraints`, `handoff_policy`, …). **Stays as-is** — orthogonal to this work. |

### Plan creation API (`parallel-agent-platform/apps/api`)

- `POST /api/work-items` exists at `apps/api/src/routes/work-items.ts:29-49`. Accepts `ManualWorkItemRequestSchema` (`workspace_id, title, description, planId, priority, labels, metadata, state`); writes one task via `upsertTaskFromNormalizedWorkItem()`.
- **`POST /api/plans` does not exist.**
- **No JSON-Schema-based plan validation.** `zod` is the validator (`apps/api/package.json:34`). `ajv` is transitive only.
- **No `packages/plan-schema/`** — that package needs to be created.
- Contracts live in `parallel-agent-platform/contracts/work-items.ts` (zod schemas).

### Planning agent (`parallel-agent-runtime/apps/orchestrator`)

- Runner: `SymphonyElixir.Runner.Planner` at `lib/symphony_elixir/runner/planner.ex`. Uses OpenAI Responses API (`@responses_url = "https://api.openai.com/v1/responses"`, line 16). Default model `gpt-5.1`.
- Tool registry: `SymphonyElixir.Codex.DynamicTool.planner_tool_specs()` returns `RepositoryTools.tool_specs() ++ DatabaseTools.tool_specs() ++ PlanningProfile.tool_specs()`.
- `DatabaseTools.tool_specs()` at `planner/database_tools.ex:91-149` exposes:
  - `plan.create` — creates a plan row (workspace_id, name, description, type, is_ongoing).
  - `task.create` — creates a task row (workspace_id, name, description, priority, labels, metadata).
  - `task.update`, `plan.read`, `task.read`. **No `plan.update`.**
- Today's planner emits **one `plan.create` followed by N `task.create` round-trips per plan.** Each turn boundary involves the LLM picking the next tool — slow, error-prone, and not what OQ-01 specifies.
- `PlanHandoff.review_event/3` (`planning/plan_handoff.ex:34-61`) emits review events:
  - `plan.create` → `planner.plan.created`
  - `task.create` → `planner.task.created`

### Dashboard (`parallel-agent-platform/apps/web`)

- `apps/web/src/api/plan-review.ts` reads existing plans/tasks for review and handoff.
- `apps/web/src/components/settings/PlanReviewHandoff.tsx` renders the review UI (read-only over existing plans).
- **No "create plan" UI** — plans today are produced by the planning runner, not authored in the dashboard.

## Target state — what we're building

1. JSON Schema package shared by API, web, and (via parity tests) the runtime.
2. Migrations adding the missing columns to `plan` and `work_items`.
3. `POST /api/plans` endpoint that validates a plan body and writes plan + N work_items in one transaction.
4. The planning agent uses a single `create_plan` tool whose input schema mirrors `v1.json`. Replaces `plan.create` + `task.create`.
5. `POST /api/plans/draft-from-prompt` endpoint — accepts NL intent, returns a draft plan (does not write).
6. Dashboard UX: prompt → draft preview (form derived from schema) → approve / edit / cancel → write.
7. (deferred) CLI `harper-cli plan {get,push,run}` for the power-user lane.

## PR plan

Seven PRs across three repos. Order matters; dependencies are
called out. PRs 1 and 2 can land in parallel; everything else is
sequential.

### PR 1 — `harper-server` — Migrations: extend `plan` and `work_items`

**Repo:** `harper-server`
**Branch:** `migrations/oq-01-plan-format`

**Scope:**
- New migration file `supabase/migrations/<ts>_oq01_extend_plan_and_work_items.sql` adding:
  - On `plan`:
    - `metadata jsonb not null default '{}'`
    - `schema_version text not null default '1'`
    - `intent text` (nullable)
    - `default_runner_kind text` (nullable)
    - `default_model text` (nullable)
  - On `work_items`:
    - `instructions text` (the runner-facing brief; distinct from the human-summary `description`)
    - `depends_on uuid[] not null default '{}'` (other `work_item.id`s this depends on within the same plan)
    - `completion_gates text[] not null default '{}'` (e.g., `{lint, tests, peer-review, self-review}`)
- Update the bidirectional sync triggers (`sync_task_to_work_items`, `sync_work_items_to_task`) to no-op for the three new fields — they live on `work_items` only and don't have `task` counterparts. Document this asymmetry in a comment on the trigger.
- Backfill: `update plan set metadata = jsonb_build_object('schema_version','1') where metadata = '{}'` (so existing rows are valid against schema v1).
- Add an index `idx_work_items_plan_id_depends_on` on `(plan_id)` to support `depends_on` graph queries.

**Decided (2026-04-25):** new task-level fields land on `work_items`
only. `task` is being **deprecated** — it's a strict subset of
`work_items` and the bidirectional sync triggers are technical
debt. The phased deprecation lives in its own scope doc:
[`task-deprecation-pr-plan.md`](./task-deprecation-pr-plan.md).

What that means for PR 1:
- Add the three new columns to `work_items` only.
- Do **not** add equivalents to `task`. The existing
  `sync_task_to_work_items` trigger doesn't reference these
  fields, so they naturally stay `work_items`-only without a
  trigger change.
- Document the asymmetry in a comment on the migration so a
  future reader understands why the new fields aren't mirrored.

**Testing:**
- Verify migrations apply cleanly to a snapshot of prod-shape data.
- Verify trigger asymmetry: updating the new fields on `work_items` does not error or attempt to mirror to `task`.

### PR 2 — `parallel-agent-platform` — `packages/plan-schema/`

**Repo:** `parallel-agent-platform`
**Branch:** `feat/plan-schema-package`
**Depends on:** none (can land before or alongside PR 1)

**Scope:**
- New workspace package `packages/plan-schema/`:
  - `package.json` with `name: "@harper/plan-schema"`, exports both the raw JSON Schema and TypeScript types.
  - `v1.json` — the JSON Schema, mirroring the shape sketched in [OQ-01 §"Sketched JSON shape"](./open-questions/oq-01-plan-format.md). Top-level: `schema_version`, `title`, `intent`, `default_runner`, `default_model`, `tasks[]`. Each task: `id` (`^t-[a-z0-9-]+$`), `title`, `instructions`, `labels` (object, string→string), `depends_on` (array of task ids), `completion_gates` (enum array).
  - `src/index.ts` — exports `planSchemaV1` (the raw JSON), `validatePlan` (Ajv-backed validator returning `{ ok, errors }`), and TS types derived via `json-schema-to-ts`.
  - `src/__tests__/schema.test.ts` — locks the schema against canonical example documents (positive cases + a curated set of negative cases for each constraint).
- Add `ajv` and `json-schema-to-ts` as deps of the new package.
- Wire as a workspace dependency of `apps/api` and `apps/web` in their `package.json`.

**Testing:**
- Vitest suite over `packages/plan-schema/src/__tests__/`.
- Snapshot test: serialize the schema → deterministic output (catches accidental edits).

### PR 3 — `parallel-agent-platform` — `POST /api/plans` endpoint

**Repo:** `parallel-agent-platform`
**Branch:** `feat/post-api-plans`
**Depends on:** PR 1 (migration columns must exist), PR 2 (schema package).

**Scope:**
- New route `apps/api/src/routes/plans.ts` exposing `POST /api/plans`.
- Request body: a v1 plan document. Validated via `validatePlan` from `@harper/plan-schema`. On invalid: 400 with the Ajv error list.
- On valid: in a single Supabase transaction —
  1. Insert `plan` row with `metadata = <full request body>`, `schema_version = '1'`, `intent`, `default_runner_kind`, `default_model`, `name = title`, `workspace_id`.
  2. Insert N `work_items` rows, one per `tasks[]`. Map `tasks[i].id` → a generated UUID and persist the original short id (e.g., `t-01`) in `work_items.metadata.author_task_id` for round-tripping.
  3. Wire `depends_on` by translating short ids to the generated UUIDs and writing the resulting array to `work_items.depends_on`.
- Response: `{ plan: PlanRecord, work_items: WorkItemProjection[] }` reusing the projection types from `contracts/work-items.ts`.
- New zod schema `PlanRecordSchema` in `contracts/plans.ts` mirroring the persisted plan shape (NOT the input schema — that's `@harper/plan-schema`).
- Auth: same workspace-scoped JWT guard pattern as `POST /api/work-items`.

**Testing:**
- `apps/api/src/routes/plans.test.ts` covering: valid plan persists; invalid plan 400s; `depends_on` cycles 400 (graph validation in addition to schema); transactional rollback on partial failure.

### PR 4 — `parallel-agent-runtime` — Replace `plan.create` + `task.create` with `create_plan`

**Repo:** `parallel-agent-runtime`
**Branch:** `feat/planner-create-plan-tool`
**Depends on:** PR 3 (the tool calls the API).

**Scope:**
- New tool spec in `apps/orchestrator/lib/symphony_elixir/codex/planner/database_tools.ex`:
  - `create_plan` with input schema **byte-for-byte mirroring `packages/plan-schema/v1.json`**. Use Elixir's typed map/struct so the spec is one source for the LLM tool definition. Add a parity test (see below).
  - Implementation calls `POST /api/plans` over HTTP using the existing platform-API client (workspace-scoped JWT). The HTTP path keeps validation in one place (the API uses the schema package); the runtime is a client of that.
- Remove `plan.create`, `task.create`, `task.update`, `plan.read`, `task.read` from the planner's exposed tool list. They're an artifact of the round-trip era — the planning runner only needs `create_plan` plus the read-only repository/profile tools.
- Update the planner system prompt (`Runner.Planner.default_instructions/3` at `runner/planner.ex:309-322`):
  - Replace "create plans then create tasks" guidance with "produce one `create_plan` call describing the full plan."
  - Reference the schema fields explicitly so the LLM has a concrete example.
  - Default `max_iterations` can drop from 8 → 3 (one tool call should suffice; budget is for retry-on-validation-error).
- Update `PlanHandoff.review_event/3` (`planning/plan_handoff.ex:34-61`):
  - Emit a single `planner.plan.created` event with the full plan body in the payload, plus a derived `planner.work_item.created` per task for downstream consumers that already listen for those.
- **Add `dry_run` to the `create_plan` tool implementation in this PR** (originally drafted as part of PR 5, but the tool lives here — keeping the dry-run flag in the same PR as the tool itself avoids a window where PR 5 ships and the runtime tool still persists). When `dry_run: true`, the tool runs full Ajv-equivalent validation on the plan body and returns `{ ok: true, plan: <body> }` without calling `POST /api/plans`. When omitted or `false`, today's behavior (call the API, return the persisted shape).

**Schema parity test (CI guard):**
- `apps/orchestrator/test/symphony_elixir/codex/planner/create_plan_parity_test.exs` reads `packages/plan-schema/v1.json` from the platform repo (via a checked-in copy at `apps/orchestrator/priv/plan-schema/v1.json` synced by a Mix task `mix plan_schema.sync`). The test asserts the Elixir tool spec's input schema is structurally equivalent to the JSON Schema. Failure means the two have drifted.
- The Mix task is run as a CI step; drift fails the build.

**Testing:**
- ExUnit unit tests over the new tool implementation.
- Integration test: a planner session end-to-end produces a single `create_plan` call and a plan + work_items appear in the DB.

### PR 5 — `parallel-agent-platform` — `POST /api/plans/draft-from-prompt`

**Repo:** `parallel-agent-platform`
**Branch:** `feat/plan-draft-from-prompt`
**Depends on:** PR 4 (the runtime exposes the planner with `create_plan`).

**Scope:**
- New route `POST /api/plans/draft-from-prompt`. Body: `{ workspace_id, prompt, default_runner?, default_model? }`.
- Dispatches the runtime planning runner (existing platform→runtime client; the runner is what calls `create_plan`). Passes `dry_run: true` so the tool returns the validated plan body without persisting (the `dry_run` behavior itself is added in PR 4 — this endpoint is the first consumer).
- Response: `{ draft: <plan body> }` for the dashboard to render.
- Validation-failure semantics: if the runner can't produce a valid plan after the retry budget, return **422 Unprocessable Entity** with the Ajv error list as the body. (4xx, not 5xx — the request shape was fine; the LLM-produced content failed schema validation. Reserve 5xx for genuine server / runtime failures: runtime unreachable, Supabase down, etc.)

**Testing:**
- Unit test the dry-run path doesn't write.
- Integration test that the response shape matches the schema package.

### PR 6 — `parallel-agent-platform/apps/web` — Plan creation UI

**Repo:** `parallel-agent-platform`
**Branch:** `feat/web-plan-creation`
**Depends on:** PR 3 and PR 5.

**Scope:**
- New page `apps/web/src/pages/plans/new.tsx`:
  - Single text input: "Describe what you want."
  - On submit → `POST /api/plans/draft-from-prompt`.
  - Renders the returned `draft` via a form generated from `@harper/plan-schema` types (RJSF or a hand-rolled component — RJSF is overkill here, hand-roll based on the typed schema).
  - Inline editing: user can adjust task titles, instructions, labels, completion-gate selections, drop tasks, add tasks.
  - Buttons: **Approve** (`POST /api/plans` with the edited draft), **Cancel** (discard), **Regenerate** (re-call draft-from-prompt).
- After successful create, navigate to the existing plan-detail view (or fallback to `/plans/:id` if the route doesn't exist yet — small additive change to the existing `PlanReviewHandoff`).

**Testing:**
- Vitest + React Testing Library coverage of the draft → edit → approve flow.
- Mock the API; assert payload shape conforms to `@harper/plan-schema`.

### PR 7 — `parallel-agent-runtime` — CLI `harper-cli plan {get,push,run}` (deferred)

Not blocking the loop. Spec is in [OQ-01](./open-questions/oq-01-plan-format.md#concrete-next-step). Pull this in once the API + UI are stable.

## Sequencing summary

```
PR 1 (migrations) ─┐
                   ├──► PR 3 (API endpoint) ──► PR 4 (planner tool) ──► PR 5 (draft endpoint) ──► PR 6 (web UI)
PR 2 (schema pkg) ─┘
```

PRs 1 and 2 land first (independent). PRs 3 → 6 are linear.

## Open questions to resolve before writing code

1. **HTTP vs direct DB write from the runtime planner.** PR 4 has the planner call `POST /api/plans` over HTTP rather than writing to Supabase directly. This keeps validation in one place but adds a network hop. Confirm.
2. **What happens to the existing `plan.create` / `task.create` tools.** PR 4 removes them. The planner is the only consumer, so removal is safe — but if any other code path calls them, we need to know now. Search confirmed no other callers; flagging in case there's a path I missed.
3. **Schema-parity strategy between TS package and Elixir tool spec.** PR 4 commits a copy of `v1.json` into the runtime repo and runs a parity test in CI. Alternative: have the runtime fetch the schema from the platform at startup. Recommendation: keep the checked-in copy + parity test — it makes the runtime self-contained and the failure mode is a CI build break, not a runtime crash.

(The "`work_items` vs `task`" question that was here before is now
decided — `work_items` only, with `task` deprecated. See
[`task-deprecation-pr-plan.md`](./task-deprecation-pr-plan.md).)

## Cross-references

- [OQ-01: Plan format](./open-questions/oq-01-plan-format.md) — the source decision.
- [OQ-03: Routing config schema](./open-questions/oq-03-routing-config-schema.md) — `plan.default_runner_kind` + `plan.default_model` are inputs to routing rules.
- [OQ-12: Git/GitHub workflow](./open-questions/oq-12-git-and-source-control.md) — work_items become the unit the manager-agent reconciler reads from.
