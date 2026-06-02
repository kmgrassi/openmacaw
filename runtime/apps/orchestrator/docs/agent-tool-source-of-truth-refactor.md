# Agent Tool Source of Truth Refactor

> **Status:** This earlier plan is superseded by
> [../../../docs/agent-tool-grant-data-model-runtime-scope.md](../../../docs/agent-tool-grant-data-model-runtime-scope.md).
> Runtime should treat `agent_tool_grant` rows as the effective source of
> model-facing tools. `tool_policy_template` rows are write-time presets only.

This document scopes the refactor from runtime hard-coded tool profiles to a
database-backed tool catalog that users can inspect and manage per agent.

## Goal

When a user selects an agent, the platform should show the tools associated
with that agent. The user should be able to add tools, remove tools, and toggle
tools on or off. Runtime execution should use the same canonical source of truth
instead of a separate hard-coded mapping.

The end state is:

- `tool` is the canonical catalog of tools the platform knows about.
- `agent_tool` is the canonical per-agent tool assignment table.
- Runtime resolves allowed tools from `agent_tool` rows, with safe defaults for
  backward compatibility.
- Agent type still matters, but as a default profile/template, not as the only
  hard-coded source of truth.

## Current State

Runtime tool exposure is currently hard-coded by agent kind:

- `planning` agents receive `DynamicTool.planner_tool_specs()`.
- all other kinds receive `DynamicTool.tool_specs()`.
- `agent.tool_policy` only affects planner workspace mutation posture through
  `allow_workspace_mutation_tools`; it does not select arbitrary tools.

Relevant runtime files:

- `apps/orchestrator/lib/symphony_elixir/codex/tool_policy.ex`
- `apps/orchestrator/lib/symphony_elixir/codex/dynamic_tool.ex`
- `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`
- `apps/orchestrator/lib/symphony_elixir/launcher/server.ex`
- `apps/orchestrator/lib/symphony_elixir/agent_inventory/database.ex`

## Existing Database Schema

The generated Supabase types show these relevant tables.

### `agent`

Relevant columns:

- `id`
- `workspace_id`
- `project_id`
- `name`
- `type`
- `model_settings`
- `tool_policy`
- `status`

`tool_policy` exists, but it is a JSON policy field. It should remain useful for
coarse posture settings and advanced policy, but should not be the primary UI
source of truth for the list of enabled tools.

### `tool`

Current generated shape:

- `id`
- `name`
- `slug`
- `description`
- `type`
- `function_name`
- `parameters`
- `created_by_user_id`
- `created_at`
- `updated_at`

This is the right starting point for the canonical tool catalog. `parameters`
can hold the model-facing JSON schema or internal metadata, depending on the
tool type.

### `agent_tool`

Current generated shape:

- `id`
- `agent_id`
- `tool_id`
- `created_by_user_id`
- `created_at`
- `updated_at`

Relationships:

- `agent_tool.agent_id -> agent.id`
- `agent_tool.tool_id -> tool.id`
- `agent_tool.created_by_user_id -> user.id`

This is the right starting point for per-agent tool assignment, but it is not
yet enough for UI toggles or runtime policy. It lacks an `enabled` column and
per-assignment configuration.

### `tool_call`

Current generated shape:

- `id`
- `message_id`
- `tool_id`
- `input`
- `output`
- `created_at`

This can remain the audit/history table for executed tool calls. It should
eventually reference the `tool.id` that was resolved from the agent's enabled
tool assignments.

## Proposed Data Model

Keep the existing `tool` and `agent_tool` tables, but extend them.

### `tool`

Recommended additions:

- `runtime_name text not null`
  - Stable tool name sent to model/tool runtime, for example `plan.create` or
    `repo.search`.
  - This can initially mirror `slug` or `function_name`, but the runtime should
    have one canonical column.
- `provider text not null default 'runtime'`
  - Examples: `runtime`, `codex_dynamic`, `mcp`, `github`, `linear`,
    `openai_hosted`.
- `category text`
  - Examples: `repo_read`, `planning`, `coding`, `git`, `github`,
    `external_api`.
- `capability text`
  - Examples: `read`, `write`, `network`, `code_mutation`, `pr_mutation`.
- `input_schema jsonb`
  - Model-facing JSON schema. Prefer this over overloading `parameters` if
    `parameters` already has product meaning.
- `output_schema jsonb`
  - Optional, useful for validation and UI documentation.
- `default_enabled boolean not null default false`
  - Whether the tool is included when a default agent profile is applied.
- `is_active boolean not null default true`
  - Catalog-level availability.
- `requires_credential boolean not null default false`
- `credential_provider text`
  - Examples: `github`, `linear`, `openai`.

If we want fewer columns, keep `parameters` as metadata and add only
`runtime_name`, `category`, `capability`, `input_schema`, and `is_active` in the
first migration.

### `agent_tool`

Recommended additions:

- `workspace_id uuid`
  - Denormalized from `agent.workspace_id` for RLS and faster workspace-scoped
    queries.
- `enabled boolean not null default true`
  - UI toggle and runtime inclusion switch.
- `config jsonb not null default '{}'`
  - Per-agent tool configuration, for example default repo, search limits, or
    destination settings.
- `policy jsonb not null default '{}'`
  - Per-agent policy constraints, for example allowed paths, denied file globs,
    approval requirements, or rate limits.
- `display_order integer`
  - Stable ordering in the UI.
- `created_by_user_id uuid`
- `updated_by_user_id uuid`

Recommended constraints:

- unique `(agent_id, tool_id)`
- `agent_id` not null
- `tool_id` not null
- `enabled` not null
- foreign key to `workspace_id` if present

The `enabled` flag is the minimum required addition for the "toggle on/off"
product behavior.

## Tool Profiles

Agent type should become a default profile/template, not the runtime source of
truth.

Examples:

- `coding` default profile:
  - `linear_graphql` for current compatibility
  - future coding tools as explicitly assigned rows
- `planning` default profile:
  - `repo.list`
  - `repo.search`
  - `repo.read_file`
  - `plan.create`
  - `task.create`
  - `task.update`
  - `plan.read`
  - `task.read`
- `custom` default profile:
  - empty by default or seeded from selected backend capabilities

Default profiles can be implemented in code first, then moved into database
seed data later. The important change is that creating/selecting an agent should
materialize rows in `agent_tool`, and runtime should read those rows.

## Runtime Resolution

Introduce a resolver with this shape:

```elixir
resolve_tools(agent, runtime_settings) ::
  {:ok,
   %{
     tool_specs: [map()],
     tool_names: [String.t()],
     sandbox: map(),
     policy: map()
   }}
  | {:error, term()}
```

Resolution order:

1. Load explicit `agent_tool` rows for the agent where `enabled = true`.
2. Join each row to `tool`.
3. Filter out inactive catalog tools.
4. Validate each selected tool against runtime capability support.
5. Convert catalog rows to runtime tool specs.
6. Apply safety policy from agent type and `agent_tool.policy`.
7. Fall back to legacy hard-coded profiles only when no `agent_tool` rows exist.

The fallback is important for compatibility with existing agents. New agents
should get explicit `agent_tool` rows at creation time.

## UI/API Contract

The platform should expose:

- list all available tools for a workspace
- list tools assigned to an agent
- add a tool to an agent
- remove a tool from an agent
- enable/disable an assigned tool
- update per-agent tool config/policy

Suggested API shape:

- `GET /agents/:agent_id/tools`
  - returns assigned tools with `enabled`, catalog metadata, config, and policy
- `GET /tools`
  - returns available catalog tools
- `POST /agents/:agent_id/tools`
  - assigns a tool
- `PATCH /agents/:agent_id/tools/:agent_tool_id`
  - toggles `enabled` or updates config/policy
- `DELETE /agents/:agent_id/tools/:agent_tool_id`
  - removes assignment

For runtime launch, the launcher should inject either:

- resolved tool rows under `stored_agent.tools`, or
- only the agent id and let runtime fetch the rows directly.

Prefer launcher-side fetch/injection first because the launcher already reads
agent inventory and credentials. Runtime can remain less coupled to Supabase
table details.

## Safety Rules

Tool assignment must not mean every tool can be enabled for every agent.

Add a policy layer that can reject unsafe combinations:

- Planning agents may receive repo-read and planner database tools.
- Planning agents may not receive code mutation, git write, PR creation,
  package manager, shell, Computer Use, or Code Interpreter tools by default.
- Coding agents may receive mutation tools according to workspace policy.
- External API tools that require credentials should show unavailable or
  misconfigured state until credentials exist.
- Open-world tools should require explicit enablement.

This should be enforced at runtime even if the UI or database contains an
unsafe assignment.

## Migration Plan

### PR 1: Document Current and Target Tool Source of Truth

Repo: `parallel-agent-runtime`

Goal: document the data-model and runtime refactor.

Tasks:

- Add this document.
- Link it from the implementation docs index.
- Confirm current generated schema for `tool`, `agent_tool`, and `tool_call`.

Definition of done:

- The implementation path is documented.
- Existing runtime behavior is unchanged.

### PR 2: Runtime Tool Catalog Abstraction

Repo: `parallel-agent-runtime`

Goal: separate "known tool definitions" from "which tools an agent gets."

Tasks:

- Create a runtime `ToolCatalog` module.
- Register current tools in the catalog:
  - `linear_graphql`
  - `plan.create`
  - `task.create`
  - `task.update`
  - `plan.read`
  - `task.read`
- Keep existing hard-coded behavior through `ToolPolicy.resolve/3`.
- Add tests for catalog lookup and schema generation.

Definition of done:

- Tool specs can be looked up by name without calling agent-kind-specific
  functions.
- No behavior changes for existing agents.

### PR 3: Database Schema for Manageable Agent Tools

Repo: platform/schema owner, plus generated types consumed by runtime.

Goal: make `agent_tool` usable as a UI and runtime source of truth.

Tasks:

- Add `enabled` to `agent_tool`.
- Add `config` and `policy` JSON columns to `agent_tool`.
- Add unique `(agent_id, tool_id)`.
- Add `runtime_name`, `input_schema`, `category`, `capability`, and
  `is_active` to `tool` if not already represented elsewhere.
- Regenerate Supabase types and PostgREST schema artifacts.

Definition of done:

- The database can represent assigned, enabled, disabled, and configured tools.

### PR 4: Agent Inventory Reads Assigned Tools

Repo: `parallel-agent-runtime`

Goal: include agent tool assignments in launcher inventory.

Tasks:

- Add `AgentInventory.Tool` and `AgentInventory.AgentTool` structs.
- Add `AgentInventory.list_agent_tools(agent_id)`.
- Fetch `agent_tool` rows joined to `tool`.
- Validate rows through `SupabaseSchema` or an equivalent schema helper.
- Include assigned tools in launcher API responses.

Definition of done:

- `GET /agents/:id` or `GET /agents/:id/tools` can show assigned tools.
- Runtime tests cover empty, enabled, disabled, and unknown tool rows.

### PR 5: Runtime Resolves Tools From `agent_tool`

Repo: `parallel-agent-runtime`

Goal: make enabled `agent_tool` rows drive runtime tool exposure.

Tasks:

- Update tool policy resolution to accept assigned tool rows.
- Convert enabled tool rows to runtime tool specs through `ToolCatalog`.
- Keep legacy fallback for agents with no assignments.
- Reject unsafe assignments for planning agents.
- Add tests proving:
  - enabled rows are included
  - disabled rows are excluded
  - unknown tools are ignored or reported deterministically
  - planning agents cannot enable mutation tools by DB row alone

Definition of done:

- Runtime no longer depends only on agent kind for tool exposure.
- Existing agents remain backward compatible.

### PR 6: Platform Tool Management API

Repo: `parallel-agent-platform`

Goal: expose tool management to the UI.

Tasks:

- Add API endpoints for listing catalog tools and agent assignments.
- Add create/delete/toggle/update endpoints for `agent_tool`.
- Enforce workspace authorization and safe tool constraints.
- Return credential/misconfiguration status for tools that need credentials.

Definition of done:

- The UI can read and mutate agent tool assignments through API calls.

### PR 7: Agent Tool Management UI

Repo: `parallel-agent-platform`

Goal: let users inspect and manage an agent's tools.

Tasks:

- Add an agent tools panel.
- Show enabled/disabled state.
- Allow add/remove/toggle.
- Show unavailable credential state.
- Show safety warnings for high-risk tools.

Definition of done:

- A user selecting an agent can see and manage the tool list.

### PR 8: Seed Default Tool Assignments

Repo: platform/schema owner and runtime/platform integration.

Goal: move default profiles into database-backed assignments.

Tasks:

- Seed the `tool` catalog.
- On agent creation, materialize default `agent_tool` rows based on agent type.
- Backfill existing agents with default rows.
- Keep legacy fallback for one release after backfill.

Definition of done:

- New agents have explicit tool assignments.
- Existing agents are migrated without changing behavior.

## Open Questions

- Should `tool.parameters` become the model input schema, or should we add a
  distinct `tool.input_schema` column and keep `parameters` for product
  metadata?
- Should `agent_tool` be singular as currently generated, or should the product
  rename it to `agent_tools` for consistency?
- Should runtime fetch `agent_tool` rows directly, or should launcher inject the
  resolved tool set into `stored_agent`?
- Should default profiles be database seed rows, code templates, or both during
  migration?
- Do we need workspace-level tool availability before per-agent assignment?
