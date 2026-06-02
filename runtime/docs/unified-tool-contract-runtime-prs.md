# Unified Tool Contract — Runtime PR Plan

Repo: `parallel-agent-runtime` (this repo).

See [unified-tool-contract-scope.md](unified-tool-contract-scope.md) for
the master design.

---

## PR1 — `Tool` behaviour + `ToolRegistry` skeleton

**Branch:** `feat/tool-registry-skeleton`

**New files:**
- `apps/orchestrator/lib/symphony_elixir/tool.ex` — behaviour
- `apps/orchestrator/lib/symphony_elixir/tool_registry.ex` — dispatcher
- `apps/orchestrator/lib/symphony_elixir/tool_registry/bundles.ex` — named bundles
- `apps/orchestrator/lib/symphony_elixir/tool_call.ex` — canonical shapes
- `apps/orchestrator/test/symphony_elixir/tool_registry_test.exs`

**Behaviour:**

```elixir
defmodule SymphonyElixir.Tool do
  @callback name() :: String.t()
  @callback description() :: String.t()
  @callback parameters_schema() :: map()
  @callback bundle() :: atom() | [atom()]
  @callback execution_kind() :: :runtime | :helper | :external
  @callback execute(arguments :: map(), context :: map()) ::
              {:ok, map()} | {:error, term()}
end
```

**Registry API:**

```elixir
ToolRegistry.register(module)
ToolRegistry.get(name) :: {:ok, module} | :error
ToolRegistry.bundle(:manager) :: [name]
ToolRegistry.execute(name, args, context, allowed) ::
  {:ok, %{output: term, usage: map | nil, metadata: map | nil}}
  | {:error, :not_allowed | :unknown_tool | term}
ToolRegistry.provider_specs(tools, provider) :: [map]
```

**Acceptance criteria:**
- [ ] Behaviour compiles with all callbacks documented
- [ ] Registry uses ETS or compile-time module list (decide based on
  whether tools register at compile time)
- [ ] `execute/4` enforces allowlist before dispatch
- [ ] One example tool (`Tools.Echo`) implements the behaviour as a
  reference and is exercised by tests
- [ ] No callers changed yet — pure additive PR

**Sequencing:** The registry code is additive and can land without DB
changes. Runtime tool resolution must use effective `agent_tool_grant`
rows when that resolver is added; templates are write-time presets, not
runtime inputs.

---

## PR2 — Migrate `Manager.Tools`

**Branch:** `feat/tool-registry-manager`

**Files:**
- Split `apps/orchestrator/lib/symphony_elixir/manager/tools.ex` (884
  lines, multi-clause `execute/3`) into one module per tool under
  `apps/orchestrator/lib/symphony_elixir/manager/tools/`:
  - `list_plans.ex`, `list_work_items.ex`, `dispatch_runner.ex`,
    `merge_pr.ex`, `post_comment.ex`, `escalate_to_human.ex`,
    `snooze.ex`, `mark_done.ex`, `read_recent_events.ex`,
    `read_artifact_state.ex`
- Each implements `SymphonyElixir.Tool` with `bundle() :: :manager`
- `apps/orchestrator/lib/symphony_elixir/runner/manager.ex` — replace
  direct `Manager.Tools.execute` calls with
  `ToolRegistry.execute(name, args, context, allowed)`
- `apps/orchestrator/lib/symphony_elixir/manager/model_client/local_relay.ex`
  — replace `manager_tool_definitions/1` with
  `ToolRegistry.provider_specs(allowed, :openai_compatible)`
- Delete `Manager.Tools` once all callers migrated

**Acceptance criteria:**
- [ ] All 10 manager tools registered and resolvable by name
- [ ] Manager runner unit + integration tests pass unchanged
- [ ] Manager local-relay path tests pass unchanged
- [ ] No reference to `Manager.Tools` remains

**Sequencing:** Depends on PR1.

---

## PR3 — Migrate `Planner.DatabaseTools` + `RepositoryTools`

**Branch:** `feat/tool-registry-planner`

**Files:**
- Split `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`
  into per-tool modules under `apps/orchestrator/lib/symphony_elixir/planner/tools/`:
  - `plan_create.ex`, `plan_update.ex`, `plan_delete.ex`,
    `plan_read.ex`, `task_create.ex`, `task_update.ex`,
    `task_schedule.ex`, `task_read.ex`, `snooze_work_item.ex`
- Wrap `apps/orchestrator/lib/symphony_elixir/planner/repository_tools.ex`
  as `Tools.RepoList`, `Tools.RepoReadFile`, `Tools.RepoSearch`,
  `Tools.RepoReadSymbols` — bundle `:repo_read`
- `apps/orchestrator/lib/symphony_elixir/runner/planner.ex` — replace
  `Codex.DynamicTool.execute(...)` for planner tools with
  `ToolRegistry.execute(...)` (Codex tools still go through DynamicTool
  until PR5)

**Acceptance criteria:**
- [ ] Planner runner uses `ToolRegistry` for all DB and repo tools
- [ ] `Codex.DynamicTool` still handles non-planner Codex tools
  (transitional)
- [ ] Planner E2E smoke (`docs/CLAUDE.md` "Browser Login And Planner
  Work Item Smoke") passes

**Sequencing:** Depends on PR1.

---

## PR4 — Migrate `LocalModelCoding` executors

**Branch:** `feat/tool-registry-local-coding`

**Files:**
- Wrap shell + patch executors as `Tool` modules:
  - `Tools.ShellExec` — bundle `:coding`
  - `Tools.ApplyPatch` — bundle `:coding`
- Delete `apps/orchestrator/lib/symphony_elixir/local_model_coding/tool_executor.ex`
  and `local_executor.ex`; `LocalModelCoding.execute_tool_calls/3`
  calls `ToolRegistry.execute` directly

**Acceptance criteria:**
- [ ] `LocalModelCoding` runner uses registry only
- [ ] Coding bundle resolves to `[repo.list, repo.read_file,
  repo.search, shell.exec, apply_patch]`
- [ ] Existing local model coding tests pass

**Sequencing:** Depends on PR1, PR3 (repo tools).

---

## PR5 — Migrate `Codex.DynamicTool`

**Branch:** `feat/tool-registry-codex`

**Files:**
- Migrate every tool currently dispatched via `Codex.DynamicTool` to
  the `Tool` behaviour. Inventory the existing `dynamic_tool.ex` and
  `tool_policy.ex` to enumerate them (Linear, DB, repo, etc.).
- `apps/orchestrator/lib/symphony_elixir/codex/dynamic_tool.ex` —
  becomes a thin compat shim or deletes entirely
- `apps/orchestrator/lib/symphony_elixir/codex/tool_policy.ex` — its
  policy logic becomes `ToolRegistry.resolve_for_agent` plus bundle
  selection

**Acceptance criteria:**
- [ ] Codex runner uses registry only
- [ ] Cloud planner runner uses registry only
- [ ] All seeded `public.tool` rows correspond to registered modules

**Sequencing:** Depends on PR1, PR2, PR3.

**Risk note:** Largest blast radius. Land a feature flag
(`USE_TOOL_REGISTRY=1`) so Codex can fall back to the legacy
DynamicTool path during rollout if needed.

---

## PR6 — Canonical tool-call shape + provider adapters

**Branch:** `feat/tool-call-adapters`

**New files:**
- `apps/orchestrator/lib/symphony_elixir/tool_adapter.ex` — behaviour
- `apps/orchestrator/lib/symphony_elixir/tool_adapter/openai.ex`
- `apps/orchestrator/lib/symphony_elixir/tool_adapter/anthropic.ex`
- `apps/orchestrator/lib/symphony_elixir/tool_adapter/openai_compatible.ex`
- `apps/orchestrator/lib/symphony_elixir/tool_adapter/prompt_based.ex`
- Property-based round-trip tests

**Adapter contract:**

```elixir
@callback to_tool_specs([tool_def]) :: [map]
@callback parse_tool_calls(provider_response :: map) :: [tool_call]
@callback format_tool_result(tool_call_id, result) :: map
```

**Migration of existing parse/format code:**
- `Runner.ToolCallingLoop` argument parsing → `OpenAI.parse_tool_calls`
- `LocalModelCoding.normalize_tool_calls` → adapter dispatch by provider
- `ToolSpec.to_provider_format` → adapter `to_tool_specs`
- `ToolSpec.parse_prompt_based_tool_call` → `PromptBased.parse_tool_calls`

**Acceptance criteria:**
- [ ] Every place that parses or formats tool calls goes through an
  adapter
- [ ] One canonical `tool_call` struct/map flows through the system
- [ ] Property test: canonical → OpenAI → canonical round-trips
- [ ] Property test: canonical → Anthropic → canonical round-trips
- [ ] Edge cases: empty args, malformed JSON args, parallel tool
  calls, tool names with dots

**Sequencing:** Depends on PR1. Can run in parallel with PR2–PR5.

---

## PR7 — `LocalRelay.Session` extraction

**Branch:** `refactor/local-relay-session`

**New files:**
- `apps/orchestrator/lib/symphony_elixir/local_relay/session.ex` —
  generic dispatch + receive loop
- `apps/orchestrator/lib/symphony_elixir/local_relay/handlers/helper_managed.ex`
- `apps/orchestrator/lib/symphony_elixir/local_relay/handlers/runtime_managed.ex`
  (replaces the manager continuation logic generically)

**Refactor targets:**
- `apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex` (692
  lines) — collapses to ~100 lines: build dispatch frame, pick handler,
  call `Session.run_turn`
- `apps/orchestrator/lib/symphony_elixir/manager/model_client/local_relay.ex`
  (473 lines) — collapses to ~80 lines: shim `ModelClient` callbacks
  onto `Session.run_turn` with the runtime handler
- Delete `manager_local_relay_continuation` frame type (handler sends
  tool results via generic `Registry.send_frame`)

**Acceptance criteria:**
- [ ] Session module owns timeout, cancel, frame parsing, error
  classification, observability
- [ ] All three previous local-relay paths (LocalRelay helper-managed,
  LocalRelay cloud-managed, manager) go through `Session`
- [ ] Manager and local relay tests pass unchanged
- [ ] Helper protocol unchanged on the wire

**Sequencing:** Depends on PR2 (manager migrated).

---

## PR8 — Unify tool-calling loops + Planner local-model client

**Branch:** `feat/unified-tool-loop-planner-local`

**Refactor targets:**
- `apps/orchestrator/lib/symphony_elixir/runner/tool_calling_loop.ex`
  and the inline loop in `local_model_coding.ex` (lines 106–200) —
  collapse to one loop module:
  - Parameterized by transport (`DirectHTTP` for LocalModelCoding,
    `HelperRelay` for LocalRelay)
  - Parameterized by allowed-tool list
  - Repeated-call detection, max-iterations, per-call timeout live
    here only
- New `apps/orchestrator/lib/symphony_elixir/planner/model_client.ex`
  behaviour mirroring `Manager.ModelClient`
- New `apps/orchestrator/lib/symphony_elixir/planner/model_client/openai_responses.ex`
  (current planner default)
- New `apps/orchestrator/lib/symphony_elixir/planner/model_client/local_relay.ex`
  (sits on `Session` + runtime handler with `:planner` bundle)
- `apps/orchestrator/lib/symphony_elixir/runner/planner.ex` — pick
  model client by `execution_profile.provider`

**Acceptance criteria:**
- [ ] One tool-calling loop module; the `LocalModelCoding` inline loop
  is gone
- [ ] Planner runs end-to-end against a local model
  (`provider: "local"`) creating tasks/work items with the same tools
  as the cloud planner
- [ ] Manager and planner share the same `Session` + handler pattern
- [ ] No references to `Codex.DynamicTool` from any runner

**Sequencing:** Depends on PR4, PR5, PR6, PR7.

---

## Sequencing summary

```
PR1 ─┬─> PR2 ─┐
     ├─> PR3 ─┼─> PR4 ─> PR5 ─┐
     └─> PR6 ─┘                ├─> PR8
              PR2 ─> PR7 ─────┘
```

PR6 can run parallel with PR2–PR5 since adapters don't depend on which
tools are registered.
