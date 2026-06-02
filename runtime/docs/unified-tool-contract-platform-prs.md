# Unified Tool Contract — Platform PR Plan

Repo: `parallel-agent-platform` (TypeScript API + React UI).

See [unified-tool-contract-scope.md](unified-tool-contract-scope.md) for
the master design.

> **Status:** The older bundle/override data model in this file has been
> superseded by the grant model described in
> [agent-tool-grant-data-model-runtime-scope.md](agent-tool-grant-data-model-runtime-scope.md).
> Platform should treat `tool_policy_template` as write-time presets and
> `agent_tool_grant` rows as the effective source of model-facing tools.

> **Note:** this file lives in the runtime repo for cross-repo planning.
> When work begins, copy to `parallel-agent-platform/docs/` so the PR
> plan is checked in alongside the code that implements it.

---

## PR1 — Planner-via-local routing in execution profile

**Branch:** `feat/planner-local-execution-profile`

**Goal:** Allow an agent's execution profile to resolve to
`provider: "local"` for the planner runner, the same way coding and
manager already can.

**Files (TypeScript API):**
- Wherever execution profiles are resolved per agent — extend the
  resolver to allow `runner_kind: "planner"` + `provider: "local"`
- Validation: provider value must be one of the enum values declared
  in `apps/orchestrator/lib/symphony_elixir/execution_profile.ex`
  (`local` is allowed; `local_runtime` etc. are not — see CLAUDE.md
  enum conventions)
- Dispatch: when planner resolves to local, send the dispatch frame
  in the same shape that runtime PR8's `Planner.ModelClient.LocalRelay`
  expects

**Acceptance criteria:**
- [ ] Agents with `runner_kind: planner` + `provider: local` route
  through the local helper without falling back to OpenAI
- [ ] Diagnostic endpoint
  (`/api/diagnostic/agents/<id>?workspaceId=<ws>`) shows the
  resolved planner-local profile and helper connectivity
- [ ] Unit tests cover the planner+local resolver case

**Sequencing:** Depends on runtime PR8.

---

## PR2 — Per-agent tool grant API

**Branch:** `feat/agent-tool-grants-api`

**Goal:** Expose CRUD over effective per-agent tool grants. Template
selection may create grants, but runtime-facing reads return
`agent_tool_grant` rows joined to `tool`.

**Files (TypeScript API):**
- New endpoints under `/api/agents/:id/tools`:
  - `GET` — returns enabled and disabled grants with joined tool metadata
    and provenance such as `grant_source` or `source_tool_template_id`
  - `POST /add` — add a tool by name by creating an enabled
    `agent_tool_grant`
  - `PATCH /:grantId` — enable, disable, or update grant metadata
  - `DELETE /:grantId` — remove a grant
  - Optional template endpoint — apply a `tool_policy_template` by
    materializing the corresponding `agent_tool_grant` rows
- Validation: tool names must exist in `public.tool`; bundle names
  must not be accepted as runtime policy inputs
- Authorization: same as existing agent edit permission

**Acceptance criteria:**
- [ ] User can grant any policy-allowed catalog tool to any agent
- [ ] User can disable or remove an existing grant from an agent
- [ ] Resolved tool list matches what runtime
  `ToolRegistry.resolve_for_agent` would return
- [ ] Audit log records who changed what

**Sequencing:** Depends on harper-server PR1.

---

## PR3 — Per-agent tool grant UI

**Branch:** `feat/agent-tool-grants-ui`

**Goal:** UI on the agent settings page to manage effective tool grants.

**Files (React frontend):**
- Agent settings page — new "Tools" section showing:
  - Effective grants with enabled/disabled state
  - Template provenance where available
  - Added tools with remove/disable actions
  - Tool catalog browser (search + category/capability filters) for adding tools

**Acceptance criteria:**
- [ ] User can add, remove, enable, and disable grants through UI
- [ ] Resolved list updates live as user makes changes
- [ ] Save shows confirmation; cancel reverts
- [ ] Tool catalog shows description + parameter schema preview

**Sequencing:** Depends on PR2.

---

## PR4 — Planner local-model E2E wiring

**Branch:** `feat/planner-local-e2e`

**Goal:** Make the planning agent in the demo workspace use a local
model end-to-end and verify the work-item smoke (`CLAUDE.md` →
"Browser Login And Planner Work Item Smoke") passes against it.

**Files:**
- Seed/migration: demo planning agent gets an execution profile with
  `provider: "local"`, `model: "qwen2.5-coder:7b"` (or similar)
- E2E test that runs the smoke flow against the local-model planner
- Diagnostic endpoint output verifies planner+local routing

**Acceptance criteria:**
- [ ] Planner agent on local model creates plans, tasks, and work
  items via the `:planner` tool bundle
- [ ] Work-item smoke prompt produces a `work_items` row with
  `source: "planner"`
- [ ] Latency observed (manual) and documented for follow-up tuning

**Sequencing:** Depends on PR1, PR3, runtime PR8.
