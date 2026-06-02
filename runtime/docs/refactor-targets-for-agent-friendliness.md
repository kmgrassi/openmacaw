# Refactor Targets — Making the Codebase Easier for Agents

This is a starter list of ~12 concrete refactor targets in
`apps/orchestrator/`. Each target is a place where an AI coding agent
currently has to load a large file, hold many unrelated concerns in
working memory, and pattern-match against duplicated logic before it can
make a small change. Splitting these files and pulling out shared
helpers should reduce that overhead and lower the rate of "agent gets
lost in a 1.5k-line module" failures.

The list is prioritized by impact — top items are the ones agents are
most likely to land in for routine work. Each target lists the file,
its current line count, what it does, why it's hard, and a concrete
suggested refactor. Cross-cutting opportunities are listed at the end.

> **Note on scope.** None of these are bugs. They are structural
> improvements. They should be done one at a time, each as its own PR,
> with the existing tests kept green. Don't bundle them.

---

## 1. `apps/orchestrator/lib/symphony_elixir/orchestrator.ex` — 1,729 lines

**What it does:** Polls Linear for issues and dispatches them to worker
processes via Codex-backed runners.

**Why it's hard for agents:**
- 18+ `handle_info` patterns, each mutating shared state (running
  tasks, completed sets, retry attempts, codex token totals).
- Polling, retry-and-backoff scheduling, worker capacity allocation,
  and codex message aggregation are interleaved in one module.
- Agents asked to "tweak retry behavior" or "add a new dispatch
  condition" must read the whole file to be safe.

**Suggested refactor:**
- Extract retry/backoff into `SymphonyElixir.Orchestrator.RetryManager`
  (timer refs, attempt tracking, delay calculation).
- Extract polling state — `completed`, `claimed`, `codex_totals` —
  into `SymphonyElixir.Orchestrator.PollingState` with focused
  accessors.
- Leave the orchestrator as a thin dispatch loop.

---

## 2. `apps/orchestrator/lib/symphony_elixir/codex/app_server.ex` — 1,224 lines

**What it does:** JSON-RPC 2.0 client for the Codex app-server over
stdio; manages sessions, message round-trips, approval policies.

**Why it's hard for agents:**
- Only 4 public functions, but each is 80+ lines of nested error
  handling (3-deep `with` chains, 20+ guard/case branches in
  `run_turn`).
- Session tuple-building (port, metadata, approval_policy,
  auto_approve_requests, ...) is repeated; policy resolution is
  duplicated.

**Suggested refactor:**
- Extract session initialization into
  `SymphonyElixir.Codex.SessionBuilder` (port validation, policy
  resolution, metadata assembly).
- Extract the message loop from `run_turn/*` into
  `SymphonyElixir.Codex.MessageLoop`.
- Public API becomes a thin wrapper around those two.

---

## 3. `apps/orchestrator/lib/symphony_elixir/status_dashboard.ex` — 1,149 lines

**What it does:** Renders a live terminal UI dashboard for orchestrator
and worker activity.

**Why it's hard for agents:**
- ~126 functions mixing render scheduling, token sampling, snapshot
  diffing, and terminal formatting.
- 40+ module attributes for ANSI codes, column widths, and timing
  intervals; data assembly and presentation are tightly coupled.
- Any UI tweak risks accidentally changing snapshot semantics.

**Suggested refactor:**
- `SymphonyElixir.StatusDashboard.Styling` for ANSI + column constants.
- `SymphonyElixir.StatusDashboard.SnapshotFormatter` (pure functions,
  data-in / strings-out).
- `SymphonyElixir.StatusDashboard.RenderScheduler` for throttle and
  interval logic.
- The root module becomes a thin coordinator.

---

## 4. `apps/orchestrator/lib/symphony_elixir/launcher/server.ex` — 1,145 lines

**What it does:** GenServer that manages orchestrator instance
lifecycles — start, stop, restart, port assignment, persistence.

**Why it's hard for agents:**
- 15+ `handle_call`/`handle_info` clauses interleaved with
  orchestrator resolution, agent startup, and persistence.
- The `resolve_and_validate_agent_config` +
  `ExecutionProfile.normalize_from_config` pattern is duplicated across
  the agent and orchestrator startup paths; profile-logging is repeated
  in three places.

**Suggested refactor:**
- `SymphonyElixir.Launcher.AgentStarter` — validation, profile
  resolution, port allocation.
- `SymphonyElixir.Launcher.StateManager` — persist and recover.
- The server becomes a dispatcher.

---

## 5. `apps/orchestrator/lib/symphony_elixir/status_dashboard/codex_message.ex` — 887 lines

**What it does:** Humanizes codex event/message payloads into readable
dashboard strings.

**Why it's hard for agents:**
- 100+ `humanize_event`/`humanize_payload` clauses, each pattern-
  matching deeply on event payloads.
- `map_value`/`map_path` extraction helpers are called 30+ times with
  near-identical surrounding code.

**Suggested refactor:**
- Group humanizers by domain (session, approval, tool, error events)
  into private modules invoked from a thin top-level dispatcher.
- Extract the `map_value`/`map_path` boilerplate into
  `SymphonyElixir.StatusDashboard.PayloadExtractor`.

---

## 6. `apps/orchestrator/lib/symphony_elixir/manager/tools.ex` — 884 lines

**What it does:** Tool definitions and local execution for the
manager-agent runtime.

**Why it's hard for agents:**
- 10 tools, each with a 20–50-line execute clause that mixes argument
  validation with database query building.
- Tool-spec construction (`inputSchema`, `required`, `properties`) is
  repeated 10+ times with the same shape.

**Suggested refactor:**
- `SymphonyElixir.Manager.ToolSpecs` for reusable schema templates.
- One module per tool (`Manager.Tools.ListPlans`,
  `Manager.Tools.DispatchRunner`, ...) implementing a small behaviour.
- The root module becomes a registry + router.

---

## 7. `apps/orchestrator/lib/symphony_elixir/agent_runner.ex` — 827 lines

**What it does:** Routes work items to the appropriate runner (Codex,
OpenClaw, ComputerUse) based on labels; manages multi-turn session
lifecycle.

**Why it's hard for agents:**
- `resolve_execution_profile` is called 4+ times with slightly
  different logic; profile merging/normalization is scattered across 5
  functions.
- Worker-host selection, SSH setup, and failure handling are
  intertwined in `run_on_worker_host` and `run_with_workspace`.

**Suggested refactor:**
- `SymphonyElixir.ExecutionProfileResolver` as the single source of
  truth for profile resolution (used here and elsewhere — see #11).
- `SymphonyElixir.WorkerHostBridge` for host selection and SSH setup.
- `run/3` reduces to: resolve → select-host → delegate.

---

## 8. `apps/orchestrator/lib/symphony_elixir/config/schema.ex` — 788 lines

**What it does:** Ecto schemas for runtime config validation across
tracker, agent, polling, worker, and other settings.

**Why it's hard for agents:**
- 8 nested Ecto schemas in one file, each with a similar
  `cast`/`validate_required`/`validate_inclusion` pattern.
- Adding a new setting requires scrolling to find the right schema.

**Suggested refactor:**
- Split into `config/tracker_schema.ex`, `config/agent_schema.ex`,
  `config/polling_schema.ex`, etc.
- Shared validators (path validation, allowlist checks) into
  `SymphonyElixir.Config.Validators`.
- The root schema composes the per-domain schemas.

---

## 9. `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex` — 688 lines

**What it does:** WebSocket server implementing the runtime gateway
protocol for the web client.

**Why it's hard for agents:**
- 12+ `handle_request` clauses, each 15–40 lines of validation +
  state mutation + error handling.
- Session-store access and config-registry lookups are duplicated in
  every clause.

**Suggested refactor:**
- One handler module per domain:
  `GatewaySocket.ChatHandler`, `GatewaySocket.SessionHandler`,
  `GatewaySocket.ConfigHandler`.
- Each owns its validation, store access, and response shape.
- The socket becomes a dispatcher with shared error handling.

---

## 10. `apps/orchestrator/lib/symphony_elixir/runner/local_model_coding.ex` — 654 lines

**What it does:** Tool-calling loop for local OpenAI-compatible models
with injectable tool executors.

**Why it's hard for agents:**
- ~19 provider/profile keys scattered through function bodies; the
  same profile/config resolution pattern recurs in
  `runner/local_relay.ex` and `runner/planner.ex`.
- Tool validation and error classification are spread across
  `loop_iteration` and `handle_tool_calls`.

**Suggested refactor:**
- Consolidate the profile-resolution code paths (this file, planner,
  local_relay) into a shared `SymphonyElixir.ProfileResolution` module.
- Extract tool-validation rules into `SymphonyElixir.ToolValidation`.
- The loop reduces to: call-model → execute-tools → validate →
  continue.

---

## 11. `apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex` — 652 lines

**What it does:** Cloud-managed relay tool-calling loop for remote
model execution.

**Why it's hard for agents:**
- Correlation-ID tracking and dispatch-frame handling are mixed with
  message collection and tool-call normalization.
- Error-code mapping (`local_runtime_offline`, `endpoint_unreachable`,
  …) is duplicated from `runner/tool_calling_loop.ex`; timeout logic
  is repeated.

**Suggested refactor:**
- `SymphonyElixir.RunnerErrorHandler` shared by LocalRelay,
  ToolCallingLoop, and LocalModelCoding.
- `SymphonyElixir.FrameDispatcher` for frame routing.

---

## 12. Cross-cutting: duplicated execution-profile resolution

Not a single file — but the highest-leverage cleanup on this list.

`AgentRunner`, `Launcher.Server`, `Runner.Planner`,
`Runner.LocalModelCoding`, and `Runner.LocalRelay` each implement a
slightly different "resolve the execution profile from agent + config"
helper. They drift. Agents touching one of them have no signal that
the others exist.

**Suggested refactor:**
- Introduce `SymphonyElixir.ExecutionProfileResolver` with one public
  `resolve/2` (or `resolve_for_runner/3`) that handles the union of
  current behaviors.
- Replace the per-module copies one runner at a time, keeping tests
  green between PRs.
- Once everyone is on the resolver, the per-runner helpers can be
  deleted.

---

## Test files worth noting (symptoms, not root causes)

These tests are large because the units under test are large. They will
shrink naturally as the corresponding refactors above land — don't
refactor them first.

- `test/symphony_elixir/core_test.exs` — 1,852 lines (mirrors
  `orchestrator.ex`)
- `test/symphony_elixir/orchestrator_status_test.exs` — 1,616 lines
- `test/symphony_elixir/app_server_test.exs` — 1,534 lines (mirrors
  `codex/app_server.ex`)
- `test/symphony_elixir/workspace_and_config_test.exs` — 1,438 lines

---

## Suggested order of work

1. **#12 (ExecutionProfileResolver)** first — it unblocks cleaner
   diffs in #1, #4, #7, #10, #11.
2. **#1, #4, #7** — orchestrator/launcher/agent-runner trio. These are
   the modules agents land in most often.
3. **#2 (Codex app_server)** — once the runners are simpler, this
   becomes a focused Codex-only cleanup.
4. **#3, #5** — dashboard pair. Pure presentation, low risk.
5. **#6, #9** — tool/handler dispatchers. Same pattern, can be done
   back-to-back.
6. **#8** — config schema split. Mechanical, safe.
7. **#10, #11** — runner cleanup follows naturally from #12.

Each of these should be its own PR with no behavior change. The
existing test suites are the safety net.
