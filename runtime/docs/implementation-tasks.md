# Implementation Tasks

Scoped, independent tasks for parallel agent execution. Each task can be worked on
by a separate agent without coordination, unless a dependency is explicitly noted.

## Legend

- `[ ]` — Not started
- `[~]` — Scaffolded (module exists with `{:error, :not_implemented}` stubs)
- `[x]` — Complete

---

## Track A: WorkItem migration (rename Linear.Issue → WorkItem)

No external dependencies. Can start immediately. All changes are mechanical renaming +
adding the `source`, `metadata`, and `runner_type` fields.

### A1: Move `Linear.Issue` struct to `WorkItem`
- `[x]` New struct exists at `lib/symphony_elixir/work_item.ex`
- `[x]` Verify all fields from `Linear.Issue` are present in `WorkItem` (including `blocked_by`,
  `branch_name`, `assignee_id` which moved into `metadata`)
- `[x]` Add `from_legacy_issue/1` conversion function (scaffolded, needs testing)
- `[x]` Add unit tests for `WorkItem` struct creation and `from_legacy_issue/1`

**Files to modify:** `lib/symphony_elixir/work_item.ex`
**Files to create:** `test/symphony_elixir/work_item_test.exs`

### A2: Update Linear adapter to return WorkItem
- `[x]` Modify `Linear.Client.normalize_issue/2` to return `%WorkItem{}` instead of `%Linear.Issue{}`
- `[x]` Set `source: "linear"` on all returned items
- `[x]` Move `branch_name`, `assignee_id`, `blocked_by` into `metadata` map
- `[x]` Update `Linear.Adapter` typespecs to reference `WorkItem.t()`
- `[x]` Ensure all existing Linear adapter tests pass with `WorkItem` output

**Files to modify:**
- `lib/symphony_elixir/linear/client.ex`
- `lib/symphony_elixir/linear/adapter.ex`

### A3: Update Memory tracker to use WorkItem
- `[x]` Change `alias SymphonyElixir.Linear.Issue` to `alias SymphonyElixir.WorkItem`
- `[x]` Update all pattern matches from `%Issue{}` to `%WorkItem{}`
- `[x]` Update typespecs

**Files to modify:** `lib/symphony_elixir/tracker/memory.ex`

### A4: Update Orchestrator to use WorkItem
- `[x]` Replace `alias SymphonyElixir.Linear.Issue` with `alias SymphonyElixir.WorkItem`
- `[x]` Update all pattern matches and struct references
- `[x]` The orchestrator accesses `issue.id`, `issue.identifier`, `issue.state` — these fields
  exist on `WorkItem` with the same names, so the changes are mechanical
- `[x]` For fields that moved to `metadata` (like `assignee_id`), update access patterns
  to use `work_item.metadata.assignee_id` or `work_item.metadata[:assignee_id]`
- `[x]` Verify all existing orchestrator tests pass

**Files to modify:** `lib/symphony_elixir/orchestrator.ex`

### A5: Update AgentRunner to use WorkItem
- `[x]` Replace `alias SymphonyElixir.Linear.Issue` with `alias SymphonyElixir.WorkItem`
- `[x]` Update pattern matches in `continue_with_issue?/2` and `issue_context/1`
- `[x]` Update `run/3` function signature documentation

**Files to modify:** `lib/symphony_elixir/agent_runner.ex`

### A6: Update PromptBuilder to use WorkItem
- `[x]` Replace `Linear.Issue` references with `WorkItem`
- `[x]` Update `to_solid_map/1` to handle `metadata` map (make it accessible in templates)
- `[x]` Keep `issue` as the template variable name for backward compatibility
  (i.e., `{{ issue.identifier }}` still works, even though the struct is `WorkItem`)
- `[x]` Add test: metadata fields are accessible via `{{ issue.metadata.branch_name }}`

**Files to modify:** `lib/symphony_elixir/prompt_builder.ex`

### A7: Update test support
- `[x]` Update `test/support/test_support.exs` to use `%WorkItem{}` in test fixtures
- `[x]` Search for any remaining `%Linear.Issue{}` or `Linear.Issue` references across tests
- `[x]` Verify full test suite passes: `mix test`

**Files to modify:** `test/support/test_support.exs`, any test files referencing `Linear.Issue`

### A8: Remove or deprecate Linear.Issue
- `[x]` After all references are updated, either:
  - Delete `lib/symphony_elixir/linear/issue.ex` entirely, or
  - Keep it as a thin wrapper that delegates to `WorkItem.from_legacy_issue/1` with a
    deprecation warning
- `[x]` Ensure `mix compile --warnings-as-errors` passes with no warnings

**Depends on:** A1–A7 all complete
**Files to modify:** `lib/symphony_elixir/linear/issue.ex`

---

## Track B: Tracker adapter expansion

Depends on Track A (WorkItem must exist). Each adapter is independent of the others.

### B1: Update Tracker router for new adapter kinds
- `[ ]` Add `"database"`, `"github"`, `"api"` cases to `Tracker.adapter/0`
- `[ ]` Update `Config.validate_semantics/1` to accept new tracker kinds
- `[ ]` Update `Config.Schema.Tracker` to accept new kinds without requiring
  Linear-specific fields (e.g., `project_slug` is only required when `kind: linear`)
- `[ ]` Add config validation tests for each new tracker kind

**Files to modify:**
- `lib/symphony_elixir/tracker.ex`
- `lib/symphony_elixir/config.ex`
- `lib/symphony_elixir/config/schema.ex`

### B2: Implement Database tracker adapter
- `[~]` Scaffolded at `lib/symphony_elixir/tracker/database.ex`
- `[ ]` Implement HTTP client for Supabase/Postgres REST API (use `Req` or `HTTPoison`)
- `[ ]` `fetch_candidate_issues/0`: `GET /rest/v1/{table}?state=in.(active_states)&order=priority.asc`
- `[ ]` `fetch_issues_by_states/1`: `GET /rest/v1/{table}?state=in.(...)`
- `[ ]` `fetch_issue_states_by_ids/1`: `GET /rest/v1/{table}?id=in.(...)`
- `[ ]` `update_issue_state/2`: `PATCH /rest/v1/{table}?id=eq.{id}` with body `{state: ...}`
- `[ ]` `create_comment/2`: `POST /rest/v1/{comments_table}` or append to metadata
- `[ ]` Map row data to `%WorkItem{source: "database", ...}`
- `[ ]` Handle Supabase auth headers (`apikey`, `Authorization: Bearer`)
- `[ ]` Add config fields to schema: `endpoint`, `api_key`, `table`, `comments_table`
- `[ ]` Add tests with mocked HTTP responses

**Files to modify:** `lib/symphony_elixir/tracker/database.ex`
**Files to create:** `test/symphony_elixir/tracker/database_test.exs`

### B3: Implement API push tracker adapter
- `[~]` Scaffolded at `lib/symphony_elixir/tracker/api.ex` (GenServer with stubs)
- `[ ]` Implement `accept_item/1`: validate payload, generate ID if missing, normalize
  to `%WorkItem{source: "api"}`, store in GenServer state
- `[ ]` Implement `fetch_candidate_issues/0`: return items in active states from GenServer
- `[ ]` Implement `fetch_issues_by_states/1`: filter by normalized state
- `[ ]` Implement `fetch_issue_states_by_ids/1`: filter by ID
- `[ ]` Implement `update_issue_state/2`: update item state in GenServer
- `[ ]` Add `POST /api/v1/items` endpoint to the orchestrator HTTP router
  (`lib/symphony_elixir_web/router.ex`) that calls `Tracker.API.accept_item/1`
- `[ ]` Add the `Tracker.API` GenServer to the orchestrator supervision tree
  (only when `tracker.kind == "api"`)
- `[ ]` Add tests: push item → fetch → dispatch cycle

**Files to modify:**
- `lib/symphony_elixir/tracker/api.ex`
- `lib/symphony_elixir_web/router.ex`
- `lib/symphony_elixir/application.ex`
**Files to create:** `test/symphony_elixir/tracker/api_test.exs`

### B4: Implement GitHub tracker adapter
- `[~]` Scaffolded at `lib/symphony_elixir/tracker/github.ex`
- `[ ]` Implement poll mode: query GitHub Issues API
  - `GET /repos/{owner}/{repo}/issues?state=open&labels=...`
  - Paginate with `?page=N&per_page=100`
- `[ ]` Map GitHub issue JSON to `%WorkItem{source: "github", ...}`
  - `id` → issue number as string
  - `identifier` → `"GH-{number}"`
  - `state` → `open`/`closed`, or label-based (e.g., `status:in-progress`)
  - `url` → `html_url`
  - `labels` → GitHub label names
  - `metadata` → `%{assignee: ..., milestone: ..., pull_request: ...}`
- `[ ]` Implement `create_comment/2`: `POST /repos/{owner}/{repo}/issues/{number}/comments`
- `[ ]` Implement `update_issue_state/2`:
  - `PATCH /repos/{owner}/{repo}/issues/{number}` for open/closed
  - Add/remove labels for granular states
- `[ ]` Handle GitHub auth headers (`Authorization: Bearer {token}`)
- `[ ]` Add config fields to schema: `repository` (owner/repo format), `api_key`, `webhook_secret`
- `[ ]` Add tests with mocked HTTP responses

**Files to modify:** `lib/symphony_elixir/tracker/github.ex`
**Files to create:** `test/symphony_elixir/tracker/github_test.exs`

---

## Track C: Runner abstraction

Can start in parallel with Track A (the behavior contract doesn't depend on WorkItem
for scaffolding, but the full implementation does).

### C1: Implement Runner.Codex (extract from AppServer)
- `[x]` Scaffolded at `lib/symphony_elixir/runner/codex.ex`
- `[x]` Read and understand `lib/symphony_elixir/codex/app_server.ex` fully
- `[x]` Implement `start_session/2`: delegate to `AppServer.start_session/2`,
  passing `config` fields as options (workspace, worker_host, etc.)
- `[x]` Implement `run_turn/3`: delegate to `AppServer.run_turn/4`,
  wrapping `work_item` into the format `AppServer` expects
- `[x]` Implement `stop_session/1`: delegate to `AppServer.stop_session/1`
- `[x]` Implement `ping/1`: verify the Codex binary is available on PATH
  (`System.find_executable("codex")`)
- `[x]` `requires_workspace?/0` returns `true` (already done)
- `[x]` Add tests that verify delegation to `AppServer` functions
- `[x]` Do NOT change `AppServer` internals — wrap, don't rewrite

**Files to modify:** `lib/symphony_elixir/runner/codex.ex`
**Files to create:** `test/symphony_elixir/runner/codex_test.exs`

### C2: Wire runner resolution into AgentRunner
- `[x]` Add `Runner.resolve/2` call at the top of `AgentRunner.run_on_worker_host/4`
- `[x]` Check `runner.requires_workspace?()` before calling `Workspace.create_for_issue/2`
- `[x]` Replace direct `AppServer.start_session` / `run_turn` / `stop_session` calls
  with `runner.start_session` / `run_turn` / `stop_session`
- `[x]` Pass runner config from `Config.settings!()` into the runner
- `[x]` Default to `Runner.Codex` when no runner config exists (backward compatibility)
- `[x]` Verify all existing tests pass — behavior for Codex workloads must be identical
- `[x]` Add test: runner resolution tests (label-based routing, default fallback)

**Depends on:** C1 (Runner.Codex must work before swapping AgentRunner)
**Files to modify:** `lib/symphony_elixir/agent_runner.ex`

### C3: Add runner config to schema
- `[x]` Add `runners` embedded schema to `Config.Schema`:
  ```
  runners:
    default: codex
    codex:
      command: "codex app-server"
    openclaw:
      base_url: "https://..."
      api_key: $OPENCLAW_API_KEY
    computer_use:
      endpoint: "https://..."
      api_key: $CUA_API_KEY
  ```
- `[x]` Parse runner config in `Config.Schema.parse/1`
- `[x]` Add `Config.runner_config/0` helper to access the parsed runner config
- `[x]` Default: `%{"default" => "codex"}` (backward compatible)
- `[x]` Add schema validation tests

**Files to modify:**
- `lib/symphony_elixir/config/schema.ex`
- `lib/symphony_elixir/config.ex`

### C4: Implement Runner.OpenClaw
- `[x]` Scaffolded at `lib/symphony_elixir/runner/openclaw.ex`
- `[x]` Implement `start_session/2`:
  - `POST {base_url}/v1/runs` with work item metadata, prompt context, model config
  - Return `{:ok, %{run_id: "...", base_url: "..."}}`
- `[x]` Implement `run_turn/3`:
  - Poll `GET {base_url}/v1/runs/{run_id}` until terminal state
  - Map terminal states: `completed` → `{:ok, result}`, `failed` → `{:error, {:fatal, ...}}`
  - Configurable poll interval (default 5s) and timeout
- `[x]` Implement `stop_session/1`:
  - `POST {base_url}/v1/runs/{run_id}/cancel` (if the API supports it)
  - Otherwise no-op
- `[x]` Implement `ping/1`: `GET {base_url}/v1/health`, check for `{"ok": true}`
- `[x]` Handle auth headers from config (`api_key`)
- `[x]` Add tests with mocked HTTP responses (using Bandit inline test server)

**Files to modify:** `lib/symphony_elixir/runner/openclaw.ex`
**Files to create:** `test/symphony_elixir/runner/openclaw_test.exs`

### C5: Implement Runner.ComputerUse
- `[x]` Scaffolded at `lib/symphony_elixir/runner/computer_use.ex`
- `[x]` Implement `start_session/2`:
  - `POST {endpoint}/sessions` with session_type (browser/desktop) and work item context
  - Return `{:ok, %{session_id: "...", endpoint: "..."}}`
- `[x]` Implement `run_turn/3`:
  - `POST {endpoint}/sessions/{session_id}/action` with the prompt
  - Poll `GET {endpoint}/sessions/{session_id}` until action completes
  - Map results to standard outcome types
- `[x]` Implement `stop_session/1`:
  - `DELETE {endpoint}/sessions/{session_id}`
- `[x]` Implement `ping/1`: `GET {endpoint}/health`
- `[x]` Handle auth headers from config (`api_key`)
- `[x]` Add tests with mocked HTTP responses (using Bandit inline test server)

**Files to modify:** `lib/symphony_elixir/runner/computer_use.ex`
**Files to create:** `test/symphony_elixir/runner/computer_use_test.exs`

---

## Track D: Launcher

Independent of Tracks A–C. Can start immediately.

### D1: Implement Launcher.Server GenServer
- `[~]` Scaffolded at `lib/symphony_elixir/launcher/server.ex`
- `[ ]` Implement `start_orchestrator/1`:
  - Generate unique ID (`"orch_" <> random hex`)
  - Assign next available port from `next_port` counter
  - Build orchestrator config: generate/select WORKFLOW.md, set env vars
  - Start orchestrator under `Launcher.DynamicSupervisor` using the programmatic
    equivalent of `CLI.evaluate/2` (call `CLI.run/2` with deps that set env vars
    for the assigned port, LINEAR_API_KEY, etc.)
  - Monitor the started process
  - Store in `orchestrators` map
  - Persist state to disk
  - Return `{:ok, %{id: ..., port: ..., status: :running}}`
- `[ ]` Implement `stop_orchestrator/1`:
  - Find orchestrator by ID
  - Terminate the process via `DynamicSupervisor.terminate_child/2`
  - Remove from `orchestrators` map
  - Persist state to disk
  - Return `{:ok, %{id: ..., status: :stopped}}`
- `[ ]` Implement `handle_info({:DOWN, ...})`:
  - Find crashed orchestrator by PID
  - Log the crash
  - Restart with same config under DynamicSupervisor
  - Update PID in state
- `[ ]` Implement state persistence:
  - `persist_state/1`: write orchestrator configs to `{state_dir}/orchestrators.json`
  - `load_state/1`: read on init, restart all previously-running orchestrators
  - Only persist config + port + ID, not PIDs (those are ephemeral)
- `[ ]` Add tests: start, stop, list, crash recovery

**Files to modify:** `lib/symphony_elixir/launcher/server.ex`
**Files to create:** `test/symphony_elixir/launcher/server_test.exs`

### D2: Implement Launcher.Router HTTP API
- `[~]` Scaffolded at `lib/symphony_elixir/launcher/router.ex`
- `[ ]` The route handlers are already wired to `Launcher.Server` calls
- `[ ]` Add JSON request validation for `POST /orchestrators`:
  - Required fields: `tracker` (map with `kind`)
  - Optional fields: `repository`, `workflow_template`, `max_concurrent_agents`,
    `runners`
- `[ ]` Add proper error responses with consistent JSON envelope
- `[ ]` Add content-type headers on all responses
- `[ ]` Add request logging middleware
- `[ ]` Add tests: HTTP request/response for each endpoint

**Files to modify:** `lib/symphony_elixir/launcher/router.ex`
**Files to create:** `test/symphony_elixir/launcher/router_test.exs`

### D3: Launcher supervision tree and startup
- `[~]` Scaffolded at `lib/symphony_elixir/launcher/supervisor.ex`
- `[ ]` Add a `mix launcher.start` Mix task or escript entrypoint that boots
  the Launcher supervision tree (separate from the orchestrator CLI entrypoint)
- `[ ]` Decide: should the Launcher be a separate OTP application, or a mode
  of the existing `symphony_elixir` application? (Recommendation: separate Mix task
  that starts `Launcher.Supervisor` instead of `SymphonyElixir.Application`)
- `[ ]` Add env var support: `LAUNCHER_PORT` (default 4100), `LAUNCHER_STATE_DIR`
- `[ ]` Add health check test: boot supervisor, hit `GET /health`

**Files to modify:** `lib/symphony_elixir/launcher/supervisor.ex`
**Files to create:** `lib/mix/tasks/launcher_start.ex`

### D4: Programmatic orchestrator startup (bypass CLI)
- `[ ]` The Launcher needs to start orchestrators without shelling out to the CLI binary
- `[ ]` Extract the core startup logic from `CLI.run/2` into a function that accepts
  a config map instead of a file path:
  ```elixir
  SymphonyElixir.Orchestrator.start_from_config(%{
    port: 4000,
    repository: "https://github.com/org/repo",
    tracker: %{kind: "database", ...},
    workflow_template: "coding",
    ...
  })
  ```
- `[ ]` This function should:
  - Set application env vars (port, repo override, etc.)
  - Generate or load the WORKFLOW.md content
  - Start the orchestrator supervision tree (or a subset of it) as a child
    of the Launcher's DynamicSupervisor
- `[ ]` Each orchestrator needs its own isolated config (can't share global
  `Application.put_env` when running multiple orchestrators). Options:
  - Pass config through GenServer init opts instead of application env
  - Use a per-orchestrator config registry
- `[ ]` Add tests: start orchestrator from config map, verify it's running on assigned port

**Files to create:** `lib/symphony_elixir/orchestrator/starter.ex`
**Files to modify:** `lib/symphony_elixir/launcher/server.ex`

---

## Track E: Config and schema updates

Supports Tracks B, C, and D. Can be done incrementally.

### E1: Add runner config section to schema
- Same as C3 above (listed there for dependency tracking)

### E2: Generalize tracker config validation
- `[ ]` Current `validate_semantics/1` requires `api_key` and `project_slug` for Linear
- `[ ]` Make validation conditional on `tracker.kind`:
  - `linear`: require `api_key`, `project_slug`
  - `database`: require `endpoint`, `api_key`, `table`
  - `github`: require `repository`, `api_key`
  - `api`: no required fields (items are pushed, not polled)
  - `memory`: no required fields (test adapter)
- `[ ]` Add `endpoint`, `table`, `repository`, `webhook_secret` fields to
  `Config.Schema.Tracker` embedded schema
- `[ ]` Add config validation tests for each tracker kind

**Files to modify:**
- `lib/symphony_elixir/config/schema.ex`
- `lib/symphony_elixir/config.ex`
**Files to create:** `test/symphony_elixir/config/tracker_validation_test.exs`

### E3: Add workspace.repository to CLI and env var support
- `[x]` `--repo` CLI flag added
- `[x]` `workspace.repository` config field added to schema
- `[ ]` Add `SYMPHONY_REPOSITORY` env var support (in addition to `--repo` flag)
- `[ ]` Add env var support for `LINEAR_PROJECT_SLUG` (currently only in WORKFLOW.md)
- `[ ]` Document all env vars in a single reference section

**Files to modify:**
- `lib/symphony_elixir/config/schema.ex`
- `lib/symphony_elixir/cli.ex`

---

## Execution order and dependencies

```
Track A (WorkItem)          Track D (Launcher)         Track E (Config)
  A1 ─┬─▶ A2               D1 ─┬─▶ D4                  E2
  │   ├─▶ A3                D2  │                        E3 [x]
  │   ├─▶ A4                D3 ─┘
  │   ├─▶ A5
  │   ├─▶ A6
  │   ├─▶ A7
  │   └─▶ A8 (after A2-A7)

Track B (Trackers)          Track C (Runners)
  B1 ──▶ B2                 C1 ──▶ C2
     ──▶ B3                 C3
     ──▶ B4                 C4
                             C5
```

**Can start immediately (no dependencies):**
- A1 (WorkItem struct)
- D1, D2, D3 (Launcher — independent of everything)
- E2 (Config generalization)

**Can start after A1:**
- A2, A3, A4, A5, A6, A7 (all mechanical renames, parallelizable)
- B1 (tracker router update)
- C1 (Runner.Codex extraction)
- C3 (runner config schema)

**Can start after B1:**
- B2, B3, B4 (tracker adapters, independent of each other)

**Can start after C1:**
- C2 (wire into AgentRunner)
- C4, C5 (other runners, independent of each other)

**Must be last:**
- A8 (remove Linear.Issue, after all A-track tasks)
- D4 (programmatic startup, after D1 + understanding how config isolation works)
