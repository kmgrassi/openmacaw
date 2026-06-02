# OQ-01 — Runtime-side PR plan: replace `plan.create` + `task.create` with `create_plan`

Runtime-scoped companion to the canonical multi-repo plan in
`parallel-agent-platform/docs/oq-01-plan-format-pr-plan.md`.

This doc is for runtime engineers picking up the planner-tool
work without crossing repos. It restates **only** the runtime
work — PR 4 (the tool replacement, the focus of this doc) and
PR 7 (CLI, deferred). The other PRs (migrations, schema package,
HTTP API, draft endpoint, dashboard UI) live on the platform side
and are summarized only as dependencies.

## Why we're doing this

OQ-01 picked Option D — a hybrid plan format with **one canonical
JSON Schema** consumed by the API validator, the dashboard, and
the planning agent's tool definition. That means the planner
talks to **one** function-call tool (`create_plan`) instead of
the current `plan.create` + N×`task.create` round-trips.

See:

- The decision record: `parallel-agent-platform` / `docs/open-questions/oq-01-plan-format.md`.
- The full multi-repo PR plan: `parallel-agent-platform` / `docs/oq-01-plan-format-pr-plan.md`.

## Current planner shape (audit against this branch)

- Planner runner: `apps/orchestrator/lib/symphony_elixir/runner/planner.ex`. Uses OpenAI Responses API. Default `max_iterations = 8`.
- Tool registry: `SymphonyElixir.Codex.DynamicTool.planner_tool_specs()` concatenates `RepositoryTools.tool_specs() ++ DatabaseTools.tool_specs() ++ PlanningProfile.tool_specs()`.
- DB tools: `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`. Today's tool list at line 16:
  ```elixir
  @tools ["plan.create", "task.create", "task.update", "plan.read", "task.read"]
  ```
- Today's flow: planner LLM emits one `plan.create` call, then N `task.create` calls — one round-trip per task. Slow, error-prone, and not what OQ-01 specifies.
- Plan handoff: `apps/orchestrator/lib/symphony_elixir/planning/plan_handoff.ex` emits `planner.plan.created` (on `plan.create`) and `planner.task.created` (on each `task.create`).

## Target state

One tool: `create_plan`. The LLM emits a single function call with
the full plan body — title, intent, default runner/model, an
array of tasks (each with id, title, instructions, labels,
depends_on, completion_gates). The runtime tool implementation
calls `POST /api/plans` over HTTP and returns the persisted
shape. No N×task.create round-trip.

## Runtime PRs

### PR 4 (this doc's focus) — `feat/planner-create-plan-tool`

**Depends on:**

- Platform PR 3: `POST /api/plans` exists and accepts the plan
  schema body (the runtime tool calls this endpoint).
- Platform PR 2: `packages/plan-schema/v1.json` exists (we mirror
  it into the runtime — see the parity test below).

**Scope:**

1. **Add the new tool spec** in `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`:
   - `create_plan` with an `inputSchema` of the form:
     ```jsonc
     {
       "type": "object",
       "required": ["plan"],
       "properties": {
         "plan":    { /* byte-for-byte mirror of packages/plan-schema/v1.json */ },
         "dry_run": { "type": "boolean", "default": false }
       },
       "additionalProperties": false
     }
     ```
     This unambiguously separates two concerns:
     - The **plan body** (`properties.plan`) is the part subject to the cross-repo schema-parity check (PR 4 step 5). Drift here fails CI.
     - The **`dry_run` envelope flag** is local to the tool's request shape and not part of the plan schema. It lives outside `properties.plan`, so the parity assertion compares `inputSchema.properties.plan` vs `packages/plan-schema/v1.json`, not the whole `inputSchema`.
   - Implementation calls `POST /api/plans` over HTTP using the existing platform-API client (workspace-scoped JWT). Keeps validation in one place — the platform validates against the schema package; we're a client.
   - When the tool is invoked with `dry_run: true`, the implementation runs the same validation locally (against the mirrored schema) and returns `{ ok: true, plan: <body> }` without calling `POST /api/plans`. This is the contract the platform's `/draft-from-prompt` endpoint (Platform PR 5) consumes.

2. **Remove the old tools** from the `@tools` list and the `execute/3` clauses in `database_tools.ex`:
   - `plan.create`
   - `task.create`
   - `task.update`
   - `plan.read`
   - `task.read`

   The planner is the only consumer of these (confirmed by `git grep` in the cross-repo audit). Removal is safe.

3. **Update the planner system prompt** (`runner/planner.ex` `default_instructions/3`):
   - Replace the "create plans then create tasks" guidance with "produce one `create_plan` call describing the full plan."
   - Reference the schema fields explicitly so the LLM has a concrete worked example.
   - Drop `max_iterations` from 8 to 3. One tool call suffices in the happy path; the budget is for retry-on-validation-error.

4. **Update `plan_handoff.ex`** review-event mapping:
   - Replace the per-tool clauses with a single `create_plan` clause.
   - Emit one `planner.plan.created` event with the full plan body in the payload.
   - **Keep the existing `planner.task.created` event name.** Verified in `plan_handoff.ex:49`; a repo-wide `rg "planner.work_item.created"` finds zero existing consumers. Renaming would silently break handoff/dashboard code that listens for `planner.task.created` today. Emit one `planner.task.created` event per task entry in `tasks[]` (one per resulting `work_item` row from the API response), preserving today's contract.

5. **Schema parity test (CI guard).** Land:
   - A checked-in copy of the schema at `apps/orchestrator/priv/plan-schema/v1.json`.
   - A Mix task `mix plan_schema.sync` that pulls the platform's `packages/plan-schema/v1.json` and writes it to that path. Run as a CI step; fails the build if drift is detected.
   - An ExUnit test `apps/orchestrator/test/symphony_elixir/planner/create_plan_parity_test.exs` that loads `priv/plan-schema/v1.json` and asserts **`inputSchema["properties"]["plan"]`** of the `create_plan` tool spec is structurally equivalent. Note the field name is `inputSchema`, not `parameters` — confirmed in the existing tool specs in `database_tools.ex` (lines 96, 112, 130, 264). The assertion is scoped to `properties.plan` so the surrounding envelope (the `dry_run` flag) doesn't trigger false positives. Failure means the cross-repo schemas have drifted.

**Tests:**

- ExUnit unit tests for the new tool implementation.
- Schema parity test (above).
- Integration test: a planner session end-to-end produces a single `create_plan` call → plan + work_items appear via the platform API → `planner.plan.created` event fires.

**Deliberate non-goals in this PR:**

- The platform's draft endpoint (`POST /api/plans/draft-from-prompt`) lives in Platform PR 5. We just need the `dry_run` flag in the tool — Platform PR 5 is the consumer.
- The dashboard UI lives in Platform PR 6. Out of scope for the runtime.

### PR 7 — `feat/harper-cli-plan-commands` (deferred)

CLI for the power-user lane — `harper-cli plan {get, push, run}`.
Defer until the API + UI are stable. No runtime work needed
beyond shipping the CLI binary; the CLI is a thin wrapper over
the platform API + the same schema package.

Spec lives in `parallel-agent-platform/docs/open-questions/oq-01-plan-format.md` §"Concrete next step".

## Open questions to resolve before writing PR 4 code

(Mirrored from the platform PR plan; runtime engineers should
confirm or override.)

1. **HTTP vs direct DB write from the runtime planner.** PR 4 has the planner call `POST /api/plans` over HTTP rather than writing to Supabase directly. Keeps validation in one place; adds a network hop. Confirm.

2. **Are we sure no other code paths call `plan.create` / `task.create`?** PR 4 removes them. The cross-repo audit found no other callers — but this is the kind of thing that should be re-verified with `git grep` once your branch is checked out.

3. **Schema-parity strategy: checked-in copy + CI test (recommended)** vs runtime-fetches-at-startup. Recommendation: keep the checked-in copy + parity test. Self-contained runtime, failure mode is a CI build break (not a runtime crash).

## Cross-references

- Canonical multi-repo PR plan: `parallel-agent-platform` / `docs/oq-01-plan-format-pr-plan.md`.
- The OQ-01 decision: `parallel-agent-platform` / `docs/open-questions/oq-01-plan-format.md`.
- Existing planner architecture context:
  - `apps/orchestrator/docs/planner-tool-contract.md` — current tool-policy contract.
  - `apps/orchestrator/docs/planning-agent-readonly-architecture.md` — planner read-side boundaries.
  - `apps/orchestrator/docs/agent-tool-source-of-truth-refactor.md` — earlier refactor of how tool specs are sourced; same pattern PR 4 extends.
