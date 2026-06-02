# Repo Tools Inherit Repository Scope

## Premise

PR #377 made `task.create` inherit `repository` from a linked plan
(`plan.metadata.default_repository` → `task.metadata.repository`) and
from session-level runner_config opts. The same inheritance is missing
on the **repo-read tools** the planner uses to look at code.

Today `repo.read_file`, `repo.read_symbols`, `repo.search`, and
`repo.list` require a `workspace_id`, while the repo selector fields
(`repo_id` / `repository_id`) are present only as optional placeholders
for future repo-cache routing. After the planner has already declared
"this work targets `repo-a`" on a plan or task, having to pass that
same repository identity again on every read tool is boilerplate the
system should be able to fill in once those selectors become active.

## Current State

- `apps/orchestrator/lib/symphony_elixir/planner/repository_tools.ex`
  requires `workspace_id` today and exposes optional `repo_id` /
  `repository_id` fields in the shared schema.
- `apps/orchestrator/lib/symphony_elixir/planner/tools/context.ex`
  surfaces `workspace_id`, `agent_id`, `actor`, `config`,
  `req_options`, `rg_path`, `search_timeout_ms`, `workspace_root`.
  It does **not** currently expose a "default repository" or a
  "current plan/task" pointer.
- PR #377's `default_repository/1` helper in `database_tools.ex`
  resolves opts → config → workspace, and is used at plan-create time
  and (inherited) at task-create time.

## Target State

Repo tools auto-fill the repo selector (`repo_id`, with
`repository_id` kept as the legacy alias until the whole runtime is
renamed in one coordinated sweep) when omitted, drawing from (in
order):

1. **Current task context** — when the runtime knows which work item
   the agent is processing, that item's `metadata.repository` wins.
2. **Current plan context** — when the agent is in a plan-scoped
   session (e.g., the planner is iterating on a single plan), the
   plan's `default_repository` is used.
3. **Session/runner_config opts** — the same `default_repository`
   value PR #377 reads in `database_tools.ex`.
4. **Workspace default** (future) — once `workspace_settings` carries
   a default repo, that's the final fallback.

The agent can still override by passing an explicit repo selector. The
tool result echoes which source the value came from (`repository_source:
"task" | "plan" | "session" | "explicit"`) so the agent sees what was
auto-filled.

## Phased Work

### REPO-1 — Add `default_repository/1` Helper To `Context`

- Lift the `default_repository/1` helper (and `default_runner_kind/1`)
  from `Planner.DatabaseTools` into `Planner.Tools.Context` (or a new
  `Planner.Defaults` module) so both database tools and repo tools
  can reuse it without circular imports.
- No behaviour change for `task.create` / `plan.create` — they keep
  the same precedence; this PR just relocates the helpers.

**Independent**: no consumer impact.

### REPO-2 — Resolve Repo Selector From Task/Plan/Session In Repo Tools

- `repo.read_file`, `repo.read_symbols`, `repo.search`, `repo.list`
  keep `workspace_id` required, but treat `repo_id` /
  `repository_id` as optional selectors that can be inherited.
- Each tool calls a shared `resolve_repository(args, opts)` that
  checks (in order): explicit `args["repo_id"]` /
  `args["repository_id"]`, the current task's
  `metadata.repository`, the current plan's `default_repository`,
  then the shared `default_repository(opts)`.
- When none of those resolve, return a clear error
  `{:error, {:missing_repository, "no repository selector in args,
  current task, current plan, or session defaults"}}` rather than
  silently dispatching to the wrong repo.

**Gates on**: REPO-1.

### REPO-3 — Surface The Resolved Source In Tool Results

- Tool result envelope adds `repository_source: "explicit" | "task" |
  "plan" | "session"`.
- Agent sees the value and the source. If "session" is wrong for the
  current request the agent can call again with an explicit repo
  selector.

**Independent of REPO-2 in code, but useless without it. Land in the
same PR as REPO-2 unless tests would balloon.**

## Test Cases

### Unit: explicit repo selector wins

```
given:  current task.metadata.repository = "repo-a"
        opts.default_repository = "repo-b"
when:   repo.read_file is called with repo_id = "repo-c", path = "x"
then:   reads from repo-c; result.repository_source = "explicit"
```

### Unit: task context beats plan/session

```
given:  current task.metadata.repository = "repo-a"
        current plan.default_repository = "repo-b"
        opts.default_repository = "repo-c"
when:   repo.read_file is called without `repo_id`
then:   reads from repo-a; result.repository_source = "task"
```

### Unit: plan context beats session

```
given:  no current task
        current plan.default_repository = "repo-b"
        opts.default_repository = "repo-c"
when:   repo.search is called with query="X" and no `repo_id`
then:   searches repo-b; result.repository_source = "plan"
```

### Negative: no source available

```
given:  no current task, no current plan, no opts default
when:   repo.list is called without `repo_id` (where applicable)
then:   {:error, {:missing_repository, ...}} returned to the agent
        rather than picking an arbitrary workspace repo
```

### Browser smoke

Extend the existing planner work-item smoke (per CLAUDE.md):

1. Prompt the planner: "Create a plan named Repo Inherit Smoke
   targeting `repo-a`. Create one task in it."
2. Prompt: "Read the README from the repository this plan targets."
3. Confirm the planner calls `repo.read_file` without re-specifying
   `repo_id` / `repository_id` and gets `repo-a`'s README.
4. Confirm the tool result shows `repository_source: "plan"`.

## Non-Goals

- A repository chooser UI. Repository selection lives on the plan /
  task / workspace already.
- Multi-repo per task. A task currently targets one repo; this scope
  doesn't change that.
- Inheriting `runner_kind` into repo tools (those don't dispatch a
  runner; they just read code).

## Open Questions

- How do repo tools know the "current task" / "current plan"?
  Two options:
  - (A) `context.ex` exposes `current_plan_id` / `current_task_id` and
    the runtime sets them when the agent reads or creates them. This
    overlaps with the
    `session-current-plan-id-scope.md` doc — recommend landing that
    work first.
  - (B) Repo tools accept an optional `plan_id` / `task_id` arg, and
    the agent passes them when relevant. Less magic, more typing.
- Should `repo.list` (workspace-wide repo enumeration) ignore the
  inheritance entirely? Default proposal: yes — listing is the
  exception; a repo selector is meaningless for an enumeration call.

## Companion PRs

- `session-current-plan-id-scope.md` (current-context tracking) — if
  REPO-2 needs current_task_id / current_plan_id from session.
- PR #377 — the precedent this scope follows.
