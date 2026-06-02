# Planning Agent Scope

This Scope-It document defines the planning-agent rollout across
`parallel-agent-runtime` and `parallel-agent-platform`.

The implementation should land as small PRs. Each task below is intentionally
scoped so one PR touches one repo.

## Problem

The current runtime and platform flows assume the user is creating or chatting
with a coding-capable agent. We need a second first-class agent kind:

- `coding` agent: the existing execution path that can work on code and run the
  current runtime tools.
- `planning` agent: a worker-side agent whose primary job is to create plans,
  break plans into tasks, and write those plans/tasks to Linear or to the
  platform database.

The platform UI also needs a `custom` path where the user can select an agent
type and specify a local/remote runtime target, for example a local OpenClaw
instance.

## Current Hooks To Reuse

Runtime:

- `AgentInventory.Agent.type` already surfaces the platform `agent.type` field.
- `AgentInventory.Agent.tool_policy` already carries policy/configuration for
  per-agent tool access.
- `AgentInventory.Agent.model_settings` already carries model/provider metadata.
- `gateway_config` already stores per-agent and per-workspace launch config.
- `Tracker.Database` already reads and writes the `work_items` queue by default.
- `WorkItem` already includes `id`, `task_id`, and `plan_id`; new planner-created
  tasks should use `WorkItem.id` / `work_items.id` as the routing identifier.

Platform:

- Supabase has `agent.type`, `agent.model_settings`, and `agent.tool_policy`.
- Supabase has canonical `plan` and `work_items` tables. `task` may still exist
  as a legacy shim but planner tools should not create new `task` rows.
- The API already has stored-agent setup/list flows.
- The web app already lists agents and can resolve the selected agent for chat.

The first rollout should reuse those surfaces. Do not add new tables until a PR
proves the existing `plan`, `work_items`, `agent`, `gateway_config`, and
`gateway_config_state` tables are insufficient.

## Agent Kinds

Use the platform `agent.type` string as the source of truth.

Initial values:

- `coding`: default for existing agents and all backward-compatible paths.
- `planning`: planner that can create plans/tasks but should not run arbitrary
  code/workspace modification tools.
- `custom`: user-specified runtime target. The concrete behavior comes from
  `model_settings` and `gateway_config`.

Runtime should treat a missing or empty `agent.type` as `coding`.

## Planning Agent Tool Boundary

The planner must receive a narrower tool profile than the coding agent.

Required database-backed tools:

- `plan.create`
  - input: `workspace_id`, `name`, optional `description`, optional `type`,
    optional `is_ongoing`
  - writes `plan`
  - returns the created `plan.id`
- `task.create`
  - input: `workspace_id`, optional `plan_id`, `name`, optional `description`,
    optional `instructions`, optional `priority`, optional `labels`, optional
    `metadata`, optional `depends_on`, optional `completion_gates`
  - `plan_id`, when supplied, must be the database `plan.id` UUID for a plan in
    the same `workspace_id`
  - writes `work_items` directly, with `name` stored as `title`
  - returns the created `work_items.id`
- `task.update`
  - input: `workspace_id`, `task_id`, allowed fields: `name`, `description`,
    `instructions`, `priority`, `labels`, `metadata`, `status`, `state`,
    `depends_on`, `completion_gates`
  - `task_id` must be the database `work_items.id` UUID
  - update predicate must include both `id = task_id` and
    `workspace_id = workspace_id`
  - writes `work_items`
- `plan.read`
  - input: `workspace_id`, `plan_id`
  - `plan_id` must be the database `plan.id` UUID
  - read predicate must include both `id = plan_id` and
    `workspace_id = workspace_id`
- `task.read`
  - input: `workspace_id`, `task_id`
  - `task_id` must be the database `work_items.id` UUID
  - read predicate must include both `id = task_id` and
    `workspace_id = workspace_id`
  - read-only lookup tools for planner self-checks

Planner tools must use database IDs for row-level reads and writes. Do not use
names, slugs, Linear identifiers, or external IDs as mutation targets. When a
tool needs to operate on an existing database row, it must receive that row's
database UUID and a mandatory workspace predicate. This is required because the
runtime-side PostgREST client uses service-role credentials in deployed
environments; workspace scoping is the application-level safety boundary for
planner read/update tools.

Optional Linear-backed tools:

- `linear.issue.create`
- `linear.issue.update`
- `linear.project.read`
- `linear.team.read`

The planner should not get shell, filesystem write, git, package manager, or
workspace mutation tools in the first rollout.

## Custom Agent Target

For `agent.type = "custom"`, the platform should persist the target in
`gateway_config.config_json` or `agent.model_settings`. Prefer
`gateway_config.config_json` for launch/runtime details and `model_settings` for
human-readable provider/model selection.

Recommended shape:

```json
{
  "backend": {
    "type": "openclaw_ws",
    "base_url": "ws://127.0.0.1:7788",
    "agent_id": "planner-local"
  }
}
```

The first UI pass only needs to collect and persist the custom target. Runtime
execution through OpenClaw can remain behind the backend-adapter rollout unless
the selected backend is already implemented.

## PR Plan

### PR 1: Runtime agent kind contract

Repo: `parallel-agent-runtime`

Goal: make agent kind explicit in runtime without changing existing behavior.

Tasks:

- Normalize missing `agent.type` to `coding`.
- Add a small runtime helper for `coding`, `planning`, and `custom` kind checks.
- Include `type` in launcher public responses if it is not already covered by
  tests.
- Add tests that prove existing agents without `type` still start as `coding`.

Definition of done:

- No existing coding-agent launch path changes.
- Runtime has one canonical place to answer "what kind of agent is this?"

### PR 2: Runtime planner tool contract

Repo: `parallel-agent-runtime`

Goal: define the planner tool interface and enforce planner_safe tool policy.

Tasks:

- Add planner tool names and input schemas in runtime docs/tests.
- Add a planner tool-policy resolver that maps `agent.type = "planning"` to the
  database-backed planner tools.
- Ensure coding agents keep the current tool profile.
- Reject shell/filesystem/git mutation tools for planner agents unless
  explicitly enabled by `tool_policy`.

Definition of done:

- Planner agents get a deterministic allowlist.
- Coding agents remain backward compatible.

### PR 3: Runtime database planner tools

Repo: `parallel-agent-runtime`

Goal: implement database-backed plan/task tools using the existing PostgREST
client.

Tasks:

- Implement `plan.create`, `task.create`, `task.update`, `plan.read`, and
  `task.read`.
- Reuse the platform `plan` and `task` tables.
- Require `workspace_id` on creates.
- Require `workspace_id` plus database IDs (`plan.id` / `task.id`) on all reads
  and updates.
- Include the workspace predicate in every read/update PostgREST query so a
  supplied UUID cannot cross workspace boundaries.
- Preserve `task.plan_id` links so `work_items.plan_id` remains meaningful.
- Add request/response tests with `Req.Test` or the repo's existing PostgREST
  test pattern.

Definition of done:

- A planner can create a plan and tasks in the database without Linear.
- Planner reads/updates are constrained by database UUID and `workspace_id`.
- No new database tables are required.

### PR 4: Runtime Linear planner tools

Repo: `parallel-agent-runtime`

Goal: add optional Linear-backed task creation for teams that want planning
output in Linear.

Tasks:

- Implement Linear create/update wrappers behind explicit config.
- Keep database tools as the default path.
- Make the destination selectable by `tool_policy.planning.destination`, with
  initial values `database` and `linear`.
- Add tests for disabled Linear config and happy-path request construction.

Definition of done:

- Planning can target Linear without changing the database planner path.

### PR 5: Platform agent creation API supports kind and custom target

Repo: `parallel-agent-platform`

Goal: let the platform create/update agents with `coding`, `planning`, or
`custom` kind.

Tasks:

- Extend shared contracts to include `agent_type`.
- Persist `agent.type`.
- Persist planner/custom `tool_policy` defaults.
- For custom agents, persist runtime target config to `gateway_config` for the
  selected agent.
- Preserve existing setup defaults as `coding`.

Definition of done:

- API callers can create a planning agent without direct Supabase writes.
- Existing coding setup remains unchanged.

### PR 6: Platform UI agent type selector

Repo: `parallel-agent-platform`

Goal: expose agent-kind selection in the web UI.

Tasks:

- Add a create-agent/edit-agent flow with a segmented selector for `Coding`,
  `Planning`, and `Custom`.
- Show planner-specific destination choice: `Database` or `Linear`.
- Show custom target inputs when `Custom` is selected.
- Validate required fields before submit.
- Display agent kind in the agent list/detail surfaces.

Definition of done:

- A user can create/select a planning agent from the UI.
- A user can enter a custom OpenClaw target without editing JSON manually.

### PR 7: Platform runtime prepare honors selected kind

Repo: `parallel-agent-platform`

Goal: make runtime preparation aware of selected agent kind without adding a new
browser transport.

Tasks:

- Pass selected agent id through existing runtime prepare/start calls.
- Surface clear errors when a `custom` backend is configured but not supported by
  the runtime yet.
- Keep browser chat routed through the existing API/runtime websocket flow.
- Add API/web tests around planning/custom selection.

Definition of done:

- Selecting a planning agent prepares the correct runtime agent.
- Selecting unsupported custom backends fails clearly.

## Sequencing

Recommended order:

1. PR 1: Runtime agent kind contract.
2. PR 2: Runtime planner tool contract.
3. PR 5: Platform API supports kind and custom target.
4. PR 6: Platform UI agent type selector.
5. PR 3: Runtime database planner tools.
6. PR 7: Platform runtime prepare honors selected kind.
7. PR 4: Runtime Linear planner tools.

This order lets the UI/API persist intent early while runtime functionality
lands behind safe defaults.

## Acceptance Criteria

- Existing coding agents continue to work without `agent.type` populated.
- A planning agent can be created from the platform UI.
- A planning agent receives only planner_safe tools by default.
- A planning agent can write a `plan` and linked `task` rows to the database.
- Linear task creation is optional and explicitly configured.
- A custom agent can store a local OpenClaw target from the UI.
- Unsupported custom execution targets produce actionable errors rather than
  silent fallback to coding-agent behavior.

## Open Questions

- Should `planning` agents use the same chat UI as coding agents, or should the
  UI show a plan/task review surface after the first planner response?
- Should planner-created database tasks start in `todo`, `draft`, or a new
  planner-specific status?
- Should the platform enforce workspace membership before writing custom
  `gateway_config` rows, or should that remain API-route-specific?
- Should Linear-created issues also mirror into the database `task` table
  immediately, or rely on webhook ingestion to backfill?
