# Planner Tool Contract

Runtime planner agents are selected with `stored_agent.type: planning`, sourced
from the platform `agent.type` field. Missing, empty, or unknown types resolve
to `coding` for backward compatibility.

## Effective Tool Grants

The model-facing planner tool set for a turn is the effective grant set supplied
to runtime as `tool_definitions` / `toolDefinitions`. Runtime does not
interpret `tool_policy_template` selections as live policy, and it does not
re-add role default tools after Platform has supplied an effective grant list.

When `tool_definitions` is present:

- planner Responses requests translate exactly those definitions to provider
  tools
- planner local-relay dispatch frames carry exactly those definitions plus the
  provider-specific translation
- planner tool execution uses the same definition names as the turn allowlist,
  so a removed grant is denied even if the tool exists in the runtime registry

## Fallback Tool Profiles

- `coding` and `custom` agents keep the existing Codex dynamic tool profile:
  `linear_graphql`.
- `planning` agents receive the database planner dynamic tools:
  `plan.create`, `task.create`, `task.update`, `plan.read`, and `task.read`,
  plus the read-only repository index tool `repo.read_symbols`.

These profiles are a local fallback for tests, development, and the transition
period before runtime resolves `agent_tool_grant` directly. They are not the
persistent source of truth once Platform sends `tool_definitions`.

Repository indexing is a read-only planner accelerator. Raw repository file
reads remain the source-of-truth fallback when a symbol result is absent or
stale.

## Planner Database Tools

`plan.create`

- Required input: `workspace_id`, `name`
- Optional input: `description`, `type`, `is_ongoing`
- Returns the created database `plan.id` once implemented.

`task.create`

- Required input: `workspace_id`, `name`
- Optional input: `plan_id`, `description`, `instructions`, `priority`,
  `labels`, `metadata`, `depends_on`, `completion_gates`, `state`
- `plan_id`, when supplied, must be the database `plan.id` UUID for a plan in
  the same `workspace_id`.
- Creates a `work_items` row directly. `name` is stored as `title`; `instructions`
  defaults to `description`, then `name`.
- Returns the created database `work_items.id`.

`task.update`

- Required input: `workspace_id`, `task_id`
- Optional input: `name`, `description`, `instructions`, `priority`, `labels`,
  `metadata`, `status`, `state`, `depends_on`, `completion_gates`
- `task_id` must be the database `work_items.id` UUID.
- Runtime execution must predicate updates by both `id = task_id` and
  `workspace_id = workspace_id`.

`plan.read`

- Required input: `workspace_id`, `plan_id`
- `plan_id` must be the database `plan.id` UUID.
- Runtime execution must predicate reads by both `id = plan_id` and
  `workspace_id = workspace_id`.

`task.read`

- Required input: `workspace_id`, `task_id`
- `task_id` must be the database `work_items.id` UUID.
- Runtime execution must predicate reads by both `id = task_id` and
  `workspace_id = workspace_id`.

## Planner Repository Index Tools

`repo.read_symbols`

- Required input: `workspace_id`
- Optional input: `repo_id`, `path`, `query`, `kinds`, `limit`
- Returns a bounded list of indexed symbols with `path`, `line`, `kind`, `name`,
  and `signature`.
- The runtime ignores caller-provided filesystem roots and scopes indexing to
  the current Codex session workspace.
- The index skips common dependency/build directories and secret-like files.
- The index is read-only and never changes the repo checkout.

## Repository Read Tools

Repository-read tools are contract-only in this PR and are not exposed through
the current Codex tool policy. Runtime execution and planner exposure land in
later PRs.

Repository-read tools use stable `repo.*` names and share these inputs:

- `workspace_id`: workspace database UUID.
- `repo_id`: repository identifier for the materialized workspace or repo
  cache.
- `path`: repository-relative path for list and file-read operations.
- `query`: search query for repository search.
- `limit`: optional bounded result or byte limit, depending on the tool.

`repo.list`

- Required input: `workspace_id`, `repo_id`, `path`
- Optional input: `max_depth`, `limit`
- Output limits: default 50 entries, maximum 200 entries.

`repo.search`

- Required input: `workspace_id`, `repo_id`, `query`
- Optional input: `path`, `limit`
- Output limits: default 50 results, maximum 100 results, maximum 4096 bytes per
  snippet.

`repo.read_file`

- Required input: `workspace_id`, `repo_id`, `path`
- Optional input: `limit`
- Output limits: maximum 65536 bytes per file response.

Repository-read implementations must reject path traversal and absolute
repository-relative paths, resolve symlinks before access, reject symlink
escapes from the materialized workspace or repo cache, and deny secret-like
files by default. Secret-like files include env files, private keys, and
credential/config files.

## Mutation Boundary

Planning agents default to a read-only Codex sandbox so shell, filesystem, git,
package-manager, and workspace mutation tools are not available by default.

The platform can explicitly opt a planning agent back into the configured
workspace mutation posture by setting:

```yaml
stored_agent:
  type: planning
  tool_policy:
    planning:
      allow_workspace_mutation_tools: true
```

Without that opt-in, the runtime resolves `thread_sandbox` to `read-only` and
the turn sandbox policy to:

```json
{"type": "readOnly", "networkAccess": false}
```
