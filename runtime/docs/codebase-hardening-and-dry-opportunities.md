# Codebase Hardening and DRY Opportunities

This document lists areas where the orchestrator and worker code can be hardened by extracting shared helpers, adapters, or middleware-style boundaries. The goal is not a broad rewrite. Most of these can be introduced as small modules, then adopted file-by-file as related code changes happen.

## Highest-Value Opportunities

| Area | Current Pattern | Proposed Reuse Point | Why It Helps |
| --- | --- | --- | --- |
| PostgREST HTTP clients | `Req` setup and response normalization are repeated in Supabase-backed adapters. | `SymphonyElixir.PostgRESTClient` | Centralizes auth headers, `prefer` handling, test injection, status handling, and error shape. |
| Generic HTTP runner clients | `Runner.OpenClaw` and `Runner.ComputerUse` both build bearer JSON requests and poll remote jobs. | `SymphonyElixir.Runner.HttpClient` and `SymphonyElixir.Runner.Poller` | Reduces duplicated retryable/fatal mapping and makes remote runner behavior consistent. |
| Time parsing/formatting | `DateTime.from_iso8601/1`, `DateTime.to_iso8601/1`, and `DateTime.utc_now/0` wrappers appear in several modules. | `SymphonyElixir.Time` | Consistent truncation, nil handling, and easier deterministic tests. |
| Map shaping | `maybe_put`, `drop_nil_values`, `stringify`, and required-field fetching are local private helpers in multiple modules. | `SymphonyElixir.MapUtils` or narrower domain helpers | Avoids many small helper copies and normalizes payload shaping. |
| Workspace path validation | Workspace-root checks are implemented separately in `Workspace`, `Codex.AppServer`, and `WorkerBridge.Server`. | Extend `SymphonyElixir.PathSafety` with workspace-aware validation. | Hardens symlink escape checks and keeps local/remote path rules explicit. |
| Worker/common duplication | `workers/common/symphony_elixir/codex/app_server.ex` is identical to the orchestrator copy, while `workspace.ex` has mostly shared code with one bootstrap delta. | A real shared library or scripted sync check | Prevents drift in security-sensitive worker/runtime logic. |
| Gateway request dispatch | `GatewaySocket` directly decodes frames, validates params, routes methods, builds responses, and starts runners. | `Gateway.Frame`, `Gateway.Dispatcher`, and request middleware | Makes validation, auth/scope checks, telemetry, and error formatting reusable. |
| Test environment setup | Tests repeatedly manage app env, system env, temp dirs, and `Req.Test` plugs. | `SymphonyElixir.TestSupport.Env`, `Tmp`, and `ReqStub` helpers | Reduces brittle cleanup code and enables more async-safe tests. |

## PR-Scoped Implementation Plan

Each scope below is intended to be small enough for a focused pull request. The sequencing is conservative: start with low-risk helpers and tests, then migrate higher-traffic runtime paths once the shared contracts are proven.

| PR | Scope | Primary Files | Deliverable | Validation |
| --- | --- | --- | --- | --- |
| PR 1 | Add shared time helpers | `lib/symphony_elixir/time.ex`, focused tests | Introduce `SymphonyElixir.Time` with `now_iso8601/1`, `parse_iso8601/1`, and `to_iso8601/1`; migrate one or two low-risk callers. | Unit tests for nil, invalid, valid, and truncation behavior; affected module tests. |
| PR 2 | Add test env/temp-dir helpers | `test/support/test_support.exs`, optional new support modules | Add helpers for app env, system env, temp dirs, and cleanup registration; migrate a small test file. | Migrated test file plus full support module tests if split out. |
| PR 3 | Add PostgREST client foundation | `lib/symphony_elixir/postgrest_client.ex`, client tests | Centralize Supabase auth headers, request option injection, `prefer` handling, and response normalization without migrating all adapters. | New client tests using `Req.Test`, including 2xx, non-2xx, and request failure paths. |
| PR 4 | Migrate read-only PostgREST adapter | `AgentInventory.Database` and tests | Move agent inventory GET calls to `PostgRESTClient` while preserving current return shapes. | `agent_inventory/database_test.exs`; targeted format check. |
| PR 5 | Migrate tracker database adapter | `Tracker.Database` and tests | Move database tracker GET/POST/PATCH calls to `PostgRESTClient`; keep writeback semantics unchanged. | `tracker/database_test.exs`, especially writeback and comments cases. |
| PR 6 | Migrate launcher/broker PostgREST adapters | `Launcher.EngineInstance`, `Launcher.GatewayConfig.Database`, `BrokerLog` | Adopt the client for upsert, patch, and insert flows after previous migrations prove the helper. | Existing launcher, gateway config, and broker log tests. |
| PR 7 | Harden path-safety API | `PathSafety`, `Workspace`, one caller test file | Add workspace-root and path-segment validation helpers; migrate one local caller only. | New path traversal/symlink tests plus migrated caller tests. |
| PR 8 | Migrate remaining workspace validation | `Codex.AppServer`, `WorkerBridge.Server`, `Workspace` | Replace duplicated root checks with `PathSafety` helpers across runtime entry points. | App server, worker bridge, and workspace tests around invalid cwd/root/symlink behavior. |
| PR 9 | Extract runner HTTP client | `Runner.HttpClient`, `Runner.OpenClaw`, `Runner.ComputerUse` | Share bearer JSON request construction and response shape; leave polling local. | OpenClaw and ComputerUse runner tests. |
| PR 10 | Extract runner poller | `Runner.Poller`, remote runners | Share deadline, sleep, status classification, and retryable/fatal result handling. | Poller unit tests with injected fetch/classifier functions; runner tests. |
| PR 11 | Split gateway frame helpers | `GatewaySocket`, new `Gateway.Frame` | Move JSON frame decode/encode, response construction, and event construction out of the socket. | Gateway socket tests plus frame helper tests. |
| PR 12 | Introduce gateway dispatch/middleware | `GatewaySocket`, `Gateway.Dispatcher`, `Gateway.Middleware` | Move scope validation, agent fetch, and error normalization into reusable functions without changing protocol behavior. | Gateway socket tests for success, validation, and error responses. |
| PR 13 | Add command execution boundary | `Command`, `Workspace`, `SecretResolver`, mix task candidates | Centralize timeout, shell execution naming, output sanitization, and exit-status mapping; migrate one shell-heavy caller. | Command unit tests and migrated caller tests. |
| PR 14 | Add worker/common drift guard | `SpecsCheck` or a dedicated mix task, CI docs/tests | Add a check that fails when files expected to stay in sync diverge; document intentional exceptions. | Mix task/spec check tests; run the new check. |
| PR 15 | Extract work item mappers | `WorkItem.Mapper`, tracker adapters | Move source-specific row/issue-to-work-item mapping while keeping explicit source functions. | Tracker adapter tests and mapper unit tests. |

Recommended first milestone: PRs 1-5. That gives the repo shared time, test, and PostgREST foundations without touching the more complex websocket, command execution, or worker-copy boundaries.

## 1. Shared PostgREST Client

Repeated code appears in:

- `apps/orchestrator/lib/symphony_elixir/tracker/database.ex`
- `apps/orchestrator/lib/symphony_elixir/agent_inventory/database.ex`
- `apps/orchestrator/lib/symphony_elixir/launcher/engine_instance.ex`
- `apps/orchestrator/lib/symphony_elixir/launcher/gateway_config/database.ex`
- `apps/orchestrator/lib/symphony_elixir/broker_log.ex`

These modules each build Supabase headers, merge module-specific `Req.Test` options, issue GET/POST/PATCH requests, and normalize non-2xx responses into `{:error, {:http_error, status, body}}`.

Proposed module:

```elixir
defmodule SymphonyElixir.PostgRESTClient do
  def new(config, req_options \\ [])
  def get(client, table, query, opts \\ [])
  def post(client, table, payload, opts \\ [])
  def patch(client, table, query, payload, opts \\ [])
  def upsert(client, table, payload, conflict, opts \\ [])
end
```

Recommended capabilities:

- Apply `apikey`, `authorization`, and `accept` headers consistently.
- Normalize endpoint through `SymphonyElixir.Supabase.merge_connection!/1`.
- Support `prefer` values such as `return=minimal`, `return=representation`, and `resolution=merge-duplicates`.
- Preserve each adapter's existing app-env test hook, for example `:database_tracker_req_options`.
- Return consistent success shapes while allowing call sites to map `:ok`, `{:ok, body}`, or `:disabled`.

Suggested adoption order:

1. Start with `AgentInventory.Database`, because it only needs GET.
2. Move `Tracker.Database` next, covering GET/POST/PATCH.
3. Move `Launcher.EngineInstance` and `Launcher.GatewayConfig.Database` after upsert/prefer behavior is covered.
4. Finish with `BrokerLog`, which has more domain-specific payload shaping.

## 2. Runner HTTP and Polling Helpers

`Runner.OpenClaw` and `Runner.ComputerUse` share this shape:

- Start a session or run with POST.
- Submit prompt and work item context.
- Poll a status endpoint until complete, failed, cancelled, error, or timeout.
- Map transient failures to `{:error, {:retryable, reason}}`.
- Map terminal failures to `{:error, {:fatal, reason}}`.
- Use bearer auth and JSON content headers.

Proposed modules:

```elixir
defmodule SymphonyElixir.Runner.HttpClient do
  def request(method, base_url, path, body, api_key, opts \\ [])
  def get(base_url, path, api_key, opts \\ [])
  def post(base_url, path, body, api_key, opts \\ [])
  def delete(base_url, path, api_key, opts \\ [])
end

defmodule SymphonyElixir.Runner.Poller do
  def poll_until(deadline_ms, interval_ms, fetch_fun, classify_fun)
end
```

The runner modules would keep their API-specific path names and status classifiers, but share transport behavior and deadline handling. This also gives one place to add request timeouts, tracing metadata, and better error redaction.

## 3. Time and Timestamp Utilities

The codebase locally defines variations of:

- `parse_timestamp/1`
- `now_iso8601/0`
- `iso8601_now/0`
- `format_time/1`
- `to_iso8601/1`
- `maybe_iso8601/1`

Proposed module:

```elixir
defmodule SymphonyElixir.Time do
  def now, do: DateTime.utc_now()
  def now_iso8601(opts \\ [])
  def parse_iso8601(value)
  def to_iso8601(value)
end
```

Recommended behavior:

- Return `nil` for nil or invalid parse input where current callers already tolerate nil.
- Allow `truncate: :second` when payloads should avoid microsecond churn.
- Optionally support an injectable clock in tests later.

Good first adopters:

- `Tracker.Database.row_to_work_item/1`
- `Tracker.GitHub.issue_to_work_item/3`
- `Launcher.EngineInstance`
- `Launcher.GatewayConfig.Database`
- `BrokerLog`
- `WorkerBridge.Server`

## 4. Payload and Map Utilities

Several modules have local versions of small map helpers:

- `maybe_put/3`
- `drop_nil_values/1`
- `fetch_required/2`
- `stringify/1`
- `to_map/1`

Proposed module:

```elixir
defmodule SymphonyElixir.MapUtils do
  def put_present(map, key, value)
  def drop_nil_values(map)
  def fetch_required(map, key, opts \\ [])
  def stringify(value)
  def atom_or_string_get(map, key)
end
```

Use this carefully. A generic helper is only worthwhile where the semantics are truly shared. For domain-specific behavior, prefer smaller modules such as `Launcher.EngineInstance.RowBuilder` or `WorkItem.RowMapper`.

## 5. Work Item Row Mapping

`Tracker.Database`, `Tracker.GitHub`, `Tracker.API`, and likely future tracker adapters all turn source-specific records into `%SymphonyElixir.WorkItem{}`.

Proposed module:

```elixir
defmodule SymphonyElixir.WorkItem.Mapper do
  def from_database_row(row)
  def from_github_issue(owner, repo, issue)
  def normalize_labels(value)
  def metadata_url(metadata)
end
```

Benefits:

- Keeps the `WorkItem` struct as the canonical contract.
- Makes timestamp parsing, label normalization, metadata URL extraction, and source fields consistent.
- Gives tests one place to assert database row compatibility with `supabase/generated/types.ts`.

Avoid making this too abstract. The source-specific functions should remain explicit enough that schema drift is easy to spot.

## 6. Workspace and Path-Safety Boundary

`SymphonyElixir.PathSafety` already canonicalizes paths and resolves symlinks. The caller-specific workspace validation is still repeated in:

- `apps/orchestrator/lib/symphony_elixir/workspace.ex`
- `apps/orchestrator/lib/symphony_elixir/codex/app_server.ex`
- `apps/orchestrator/lib/symphony_elixir/worker_bridge/server.ex`

Proposed additions:

```elixir
defmodule SymphonyElixir.PathSafety do
  def validate_child_path(path, root, opts \\ [])
  def validate_workspace_path(path, root, opts \\ [])
  def validate_path_segment(segment)
end
```

Recommended options:

- `allow_root?: false`
- `require_exists?: true | false`
- `require_dir?: true | false`
- `remote?: true | false`
- `segment_policy: :identity | :filesystem`

This would centralize symlink escape handling and identity path segment validation. It would also make it clearer which rules apply to local paths versus remote worker paths.

## 7. Worker Common Code Packaging

There are two copied worker modules:

- `workers/common/symphony_elixir/codex/app_server.ex`
- `apps/orchestrator/lib/symphony_elixir/codex/app_server.ex`
- `workers/common/symphony_elixir/workspace.ex`
- `apps/orchestrator/lib/symphony_elixir/workspace.ex`

`Codex.AppServer` currently appears identical across both locations. `Workspace` has a small orchestrator-only repository bootstrap addition. This is a drift risk because both modules control command execution, workspace cleanup, path validation, and runtime process handling.

Options:

1. Extract a shared Mix app or internal package that both orchestrator and worker builds consume.
2. Keep the copy model but add a CI check that diffs files expected to be identical.
3. Split shared behavior into common modules and keep only thin environment-specific wrappers in each location.

Recommended first step: add a CI/spec check for files that must remain identical, then extract `Workspace.RepositoryBootstrap` so the `Workspace` delta is explicit rather than embedded in the copy.

## 8. Gateway Middleware and Frame Helpers

`GatewaySocket` currently owns several responsibilities:

- JSON frame decode/encode.
- Request dispatch by method string.
- Scope validation.
- Agent lookup.
- Session lifecycle calls.
- Runner process startup.
- Error formatting.

Proposed modules:

```elixir
defmodule SymphonyElixirWeb.Gateway.Frame do
  def decode(binary)
  def response(id, ok?, payload, error)
  def event(name, payload)
end

defmodule SymphonyElixirWeb.Gateway.Dispatcher do
  def dispatch(method, id, params, state)
end

defmodule SymphonyElixirWeb.Gateway.Middleware do
  def require_scope(state, params)
  def fetch_agent(scope)
  def normalize_error(reason)
end
```

This is a good place to add consistent logging metadata and request timing. A middleware-style helper should stay simple Elixir functions, not a framework, because the current `WebSock` callback shape is direct and easy to follow.

## 9. Config and Environment Helpers

The codebase has several local environment readers:

- `Supabase.env/1`
- `Launcher.EngineInstance.system_env/1`
- `BrokerLog.system_env/1`
- test-local `restore_env/2`

Proposed module:

```elixir
defmodule SymphonyElixir.Env do
  def get_non_empty(name)
  def restore(name, previous)
end
```

For production code, this removes subtle differences between nil and empty string handling. For tests, prefer a test-only wrapper that captures previous values and registers `on_exit/1` cleanup.

## 10. Test Support Helpers

Repeated test patterns include:

- Temporary directory creation under `System.tmp_dir!/0`.
- App env setup/cleanup.
- System env setup/cleanup.
- `Req.Test.stub/2` and app-specific `*_req_options`.
- Repeated launcher/agent inventory test state setup.

Proposed test helpers:

```elixir
defmodule SymphonyElixir.TestSupport.Env do
  def put_app_env(test, key, value)
  def put_system_env(test, key, value)
end

defmodule SymphonyElixir.TestSupport.Tmp do
  def tmp_dir!(test, prefix)
  def tmp_file!(test, prefix, extension \\ "")
end

defmodule SymphonyElixir.TestSupport.ReqStub do
  def install(test, app_env_key, plug_module)
end
```

These helpers would reduce cleanup mistakes and make async-safety decisions visible. They also make large tests such as app server, launcher, and workspace tests easier to scan.

## 11. Command Execution Boundary

Command execution appears in workspace hooks, SSH helpers, repository bootstrap, secret resolution, and mix tasks. These calls have different timeout, logging, stderr, and redaction behavior.

Proposed module:

```elixir
defmodule SymphonyElixir.Command do
  def run(executable, args, opts \\ [])
  def shell(command, opts \\ [])
  def with_timeout(fun, timeout_ms)
  def sanitize_output(output, opts \\ [])
end
```

Recommended behavior:

- Default to argument-vector execution where possible.
- Make shell execution explicit with a function name like `shell/2`.
- Centralize timeout handling and `Task.shutdown/2`.
- Redact credentials in logged command output.
- Return a consistent shape such as `{:ok, output}` or `{:error, {:exit_status, status, output}}`.

This would be especially useful around `Workspace`, `WorkerBridge.SecretResolver`, and mix tasks that shell out.

## PR Sizing Rules

- One PR should introduce at most one shared helper family and migrate at most one high-traffic caller.
- A helper-only PR is acceptable when the helper has direct tests and an obvious next migration.
- Adapter migrations should preserve public return shapes and error tuples unless the PR explicitly scopes a behavior change.
- Prefer tests that exercise both the helper and the migrated caller, not broad snapshot churn.
- Do not combine websocket protocol changes, command execution changes, and database adapter changes in the same PR.
- When a helper changes security-sensitive behavior, include regression coverage for the original risk before migrating additional callers.

## Guardrails

- Keep behavior-compatible return shapes during migration.
- Move one adapter or caller at a time and preserve existing tests.
- Prefer explicit domain helpers over generic abstractions when rules differ.
- Add regression tests around path traversal, symlink escapes, HTTP non-2xx handling, and timeout behavior before touching shared boundaries.
- Use shared helpers to harden behavior, not just reduce line count.
