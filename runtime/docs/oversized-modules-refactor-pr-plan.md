# Oversized Modules Refactor PR Plan

This replaces the previous oversized-module scoping with a current set of
10 PR-sized refactors. The goal is structural cleanup only: each PR should
preserve behavior, keep public APIs stable unless explicitly called out, and
leave unrelated files alone.

Generated files are excluded. Line counts are from the current worktree and
are approximate.

## Target Set

| PR | File | LOC | Primary Split |
| --- | --- | ---: | --- |
| 1 | `apps/orchestrator/lib/symphony_elixir/orchestrator.ex` | 1530 | retry, dispatch, worker capacity, Codex usage helpers |
| 2 | `apps/orchestrator/lib/symphony_elixir/runner/tool_calling_loop.ex` | 950 | direct-provider loop, tool-call normalization, tool execution dispatch |
| 3 | `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex` | 933 | due-query config, session lifecycle, status/error reporting |
| 4 | `apps/orchestrator/lib/symphony_elixir/launcher/server.ex` | 902 | engine-instance sync, persistence, launch config resolution |
| 5 | `apps/orchestrator/lib/symphony_elixir/status_dashboard/codex_message.ex` | 887 | event-family humanizers and payload/format helpers |
| 6 | `apps/orchestrator/lib/symphony_elixir/config/schema.ex` | 848 | embedded schemas, secret/path/sandbox resolution |
| 7 | `apps/orchestrator/lib/symphony_elixir/planner/model_client/openai_responses.ex` | 845 | tool-name mapping and planner tool execution |
| 8 | `apps/orchestrator/lib/symphony_elixir/agent_runner.ex` | 827 | turn loop, token accounting, BrokerLog adapter |
| 9 | `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex` | 727 | JSON-RPC handlers, notification translation, message logging |
| 10 | `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex` | 672 | per-tool command modules, schema helpers, PostgREST row helpers |

## PR 1: Split Orchestrator Policy Helpers

**Target:** `apps/orchestrator/lib/symphony_elixir/orchestrator.ex`

**Why:** The GenServer owns poll scheduling, Linear/work-item selection,
dispatch eligibility, retry scheduling, worker-host capacity, snapshot
assembly, and Codex usage aggregation. Small changes to retry or dispatch
policy currently require reading the whole module.

**What to extract:**

- `SymphonyElixir.Orchestrator.DispatchPolicy` for issue filtering,
  sorting, active/terminal state checks, and queue context.
- `SymphonyElixir.Orchestrator.RetryPolicy` for retry metadata, retry
  delay, stale-token handling, and attempt normalization.
- `SymphonyElixir.Orchestrator.WorkerCapacity` for preferred host
  selection, least-loaded host selection, and slot checks.
- `SymphonyElixir.UsageExtraction` for token usage and rate-limit payload
  extraction currently embedded near the bottom of the module.

**First step:** Move the pure retry helpers (`retry_delay`,
`failure_retry_delay`, `normalize_retry_attempt`, `pick_retry_*`) with
direct unit tests. Then move worker-capacity helpers.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir/orchestrator_status_test.exs`.
Run full `mix compile --warnings-as-errors && mix test` before commit.

**Parallelism:** Independent, except `UsageExtraction` should coordinate
with PR 8 if both touch token accounting.

## PR 2: Split Runner Tool Calling Loop

**Target:** `apps/orchestrator/lib/symphony_elixir/runner/tool_calling_loop.ex`

**Why:** One module handles both relay-managed collection and runtime-managed
direct provider loops. It also normalizes provider tool calls, injects runtime
context, dispatches helper/runtime tools, builds tool-result messages, emits
events, and classifies errors.

**What to extract:**

- `Runner.ToolCallingLoop.DirectProviderLoop` for `run_direct/2`,
  `direct_loop/3`, direct provider turns, and direct result message building.
- `Runner.ToolCallingLoop.ToolCallNormalization` for direct and relay
  tool-call normalization plus prompt-based tool-call parsing.
- `Runner.ToolCallingLoop.ToolExecutionDispatcher` for helper vs runtime
  registry dispatch and runtime context injection.
- `Runner.ToolCallingLoop.Events` for tool started/finished and backend
  progress normalization.

**First step:** Extract the direct provider loop and keep
`ToolCallingLoop.run_direct/2` as a facade. This gives a clear review boundary
without changing relay behavior.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir/runner`.
For changes to direct local tool calling, also run the local relay smoke if
the required helper services are available.

**Parallelism:** Independent, but avoid running alongside PR 7 if both edit
tool-name normalization helpers.

## PR 3: Split Manager Scheduler Configuration And Status

**Target:** `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`

**Why:** Scheduler state transitions, due-work-item query building, manager
session resolution, batch execution, status payload generation, and error
classification are interleaved in one GenServer.

**What to extract:**

- `Manager.Scheduler.DueQuery` for `due_query/4`, due-state normalization,
  plan-id filtering, manager-runner filtering, and cadence lookup.
- `Manager.Scheduler.SessionState` for initial session, refresh, identity,
  resolver options, and runner stop behavior.
- `Manager.Scheduler.Status` for `status_payload/1`,
  `scheduler_status/1`, missing requirements, idle errors, and normalized
  error payloads.

**First step:** Extract status/error reporting. It is mostly pure and covered
by scheduler status tests, so it is the lowest-risk split.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir/manager/scheduler_test.exs`.
If due-query behavior changes, also run `pnpm run smoke:manager -- --workspace-id <workspace-id>`.

**Parallelism:** Independent. Keep this separate from manager tool refactors.

## PR 4: Split Launcher Server Side Effects

**Target:** `apps/orchestrator/lib/symphony_elixir/launcher/server.ex`

**Why:** The launcher GenServer coordinates process lifecycle, persistent
state restore, gateway launch-config resolution, credential injection,
engine-instance Supabase synchronization, and heartbeat/reconciliation.

**What to extract:**

- `Launcher.EngineInstanceSync` for engine-instance writes, updates,
  reconciliation, heartbeat, and enabled/no-op behavior.
- `Launcher.Persistence` for state-file read/write and restored-entry
  serialization.
- `Launcher.AgentLaunchConfig` for gateway config resolution, execution
  profile normalization, local fallback, credential injection, and plan
  handoff fields.
- `Launcher.Entry` for entry serialization and field normalization.

**First step:** Extract `EngineInstanceSync`; it is side-effect-heavy but
cohesive and already has launcher tests around enabled/disabled sync paths.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir/launcher`.
For launcher/database changes, run `pnpm run smoke:runtime` when local
credentials are available.

**Parallelism:** Independent.

## PR 5: Split Dashboard Codex Message Humanizers

**Target:** `apps/orchestrator/lib/symphony_elixir/status_dashboard/codex_message.ex`

**Why:** A single formatter maps native Codex methods, wrapper events,
dynamic tool events, approvals, deltas, usage, rate limits, and fallback
payload summaries into human-readable dashboard strings.

**What to extract:**

- `StatusDashboard.CodexMessage.NativeMethods`
- `StatusDashboard.CodexMessage.WrapperEvents`
- `StatusDashboard.CodexMessage.DynamicToolEvents`
- `StatusDashboard.CodexMessage.PayloadExtraction`
- `StatusDashboard.CodexMessage.OutputFormatting`

Keep the existing `CodexMessage.humanize/1` facade as the only public entry
point.

**First step:** Extract wrapper-event handling and payload extraction helpers.
Those functions form a natural boundary and are easy to snapshot-test.

**Validation:** Run the existing dashboard/codex message tests if present,
then `cd apps/orchestrator && mix test`. During a runtime smoke, eyeball the
status dashboard for missing or generic event text.

**Parallelism:** Independent.

## PR 6: Split Config Schema Utilities

**Target:** `apps/orchestrator/lib/symphony_elixir/config/schema.ex`

**Why:** Embedded Ecto schemas, top-level parse orchestration, final-setting
normalization, secret/env expansion, path defaults, sandbox policy resolution,
state-limit validation, and error formatting all live in one module.

**What to extract:**

- `Config.SecretResolver` for `$ENV_VAR` expansion and secret normalization.
- `Config.PathResolver` for workspace/cache/artifact path defaults,
  URI detection, and canonicalization.
- `Config.SandboxPolicy` for turn/runtime sandbox policy resolution.
- `Config.Errors` for changeset error flattening and formatting.
- Optional follow-up: split embedded schemas into per-domain modules only
  after helpers are extracted.

**First step:** Extract sandbox policy resolution because it is already a
cohesive helper cluster with clear tests.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir/config`.
Then full compile/test before commit.

**Parallelism:** Independent, but coordinate with PR 4 if both touch launch
config path or secret behavior.

## PR 7: Split Planner OpenAI Responses Tool Plumbing

**Target:** `apps/orchestrator/lib/symphony_elixir/planner/model_client/openai_responses.ex`

**Why:** The OpenAI Responses planner client contains request assembly,
response decoding, output text extraction, tool-name sanitization,
collision handling, planner tool execution, dynamic tool response handling,
and error formatting.

**What to extract:**

- `Planner.ToolNameMapping` for runtime-to-provider tool-name mapping,
  safe-name generation, deduplication, and reverse lookup.
- `Planner.ToolExecutor` for registry vs dynamic tool execution and response
  normalization.
- `Planner.OpenAIResponses.ResponseParser` for output text, tool calls,
  usage, and response metadata extraction.

**First step:** Extract `Planner.ToolNameMapping` with direct tests covering
collisions, duplicate names, and already-safe names.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir/runner/planner_test.exs test/symphony_elixir/planner`.
For planner tool changes, run the browser login and planner work-item smoke.

**Parallelism:** Coordinate with PR 2 if shared tool normalization is created.

## PR 8: Split Agent Runner Accounting And Adapters

**Target:** `apps/orchestrator/lib/symphony_elixir/agent_runner.ex`

**Why:** Runner orchestration is mixed with workspace setup, execution profile
selection, multi-turn continuation, worker-host dispatch, issue refresh,
BrokerLog writes, token accumulation, message forwarding, and issue metadata
helpers.

**What to extract:**

- `AgentRunner.TurnLoop` for multi-turn execution, continuation prompts,
  max-turn handling, and issue refresh decisions.
- `AgentRunner.TokenAccumulator` for token snapshot process, usage field
  extraction, and total calculation. Prefer sharing `UsageExtraction` from PR 1.
- `AgentRunner.BrokerLogAdapter` for begin/update/finalize/record-turn calls
  and disabled-state handling.
- `AgentRunner.RunnerConfig` for execution profile and runner setting merge.

**First step:** Extract `BrokerLogAdapter`; it is optional behavior with a
small API and can be tested without changing turn-loop logic.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir/agent_runner_test.exs`
if present; otherwise run full `mix test` and add focused tests for the new
adapter/accumulator modules.

**Parallelism:** Coordinate with PR 1 if both introduce shared usage
extraction.

## PR 9: Split Gateway Socket Request Handling

**Target:** `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex`

**Why:** WebSocket callbacks, JSON-RPC method dispatch, scope validation,
session-thread persistence, runner startup, message logging, runner-event
translation, session listing, delta extraction, and error encoding are all in
one module.

**What to extract:**

- `GatewaySocket.JsonRpc` for response/error encoding and method dispatch
  return shapes.
- `GatewaySocket.Scope` for query parsing, session-key derivation, scope
  validation, and agent fetch.
- `GatewaySocket.ChatRequests`, `SessionRequests`, and `ConfigRequests` for
  method families.
- `GatewaySocket.Notifications` for runner-event translation, delta
  extraction, and assistant/user message persistence.
- `GatewaySocket.MessageLogger` for user and assistant message writes.

**First step:** Extract notification translation and delta extraction. They
are cohesive and can be verified with gateway socket tests before touching
request dispatch.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir_web/gateway_socket_test.exs`.
For auth/session changes, run the browser login and planner work-item smoke.

**Parallelism:** Independent.

## PR 10: Split Planner Database Tools

**Target:** `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`

**Why:** Planner tool dispatch, JSON schemas, argument validation,
PostgREST create/read/update helpers, task scheduling event writes, planner
metadata/routing normalization, and result/error encoding are combined in one
file. This is a frequent edit point for planner behavior.

**What to extract:**

- `Planner.DatabaseTools.Registry` or keep the current module as the registry
  and facade.
- `Planner.DatabaseTools.Specs` for `tool_specs/0`, schema helpers, and shared
  property builders.
- `Planner.DatabaseTools.PlanCommands` for create/update/delete/read plan.
- `Planner.DatabaseTools.TaskCommands` for create/update/schedule/read task.
- `Planner.DatabaseTools.RowStore` for scoped PostgREST row operations and
  row-result handling.
- `Planner.DatabaseTools.Arguments` for required/optional argument parsing,
  nullable ISO timestamp parsing, and update-payload filtering.

**First step:** Extract `Specs`. It is pure, large, and easy to verify by
asserting `DatabaseTools.tool_specs/0` remains byte-equivalent.

**Validation:** `cd apps/orchestrator && mix test test/symphony_elixir/planner/database_tools_test.exs`.
Because planner task creation is user-facing, run the browser login and
planner work-item smoke before handoff if command behavior moved.

**Parallelism:** Independent, but avoid simultaneous edits with PR 7 if both
change planner tool spec shapes.

## Honorable Mentions

These are good follow-ups but did not make the top 10:

- `apps/orchestrator/lib/symphony_elixir/linear/client.ex` (676 LOC):
  split GraphQL transport, issue normalization, pagination, and mutation
  decoding.
- `apps/orchestrator/lib/symphony_elixir/planning_profile.ex` (664 LOC):
  split profile resolution, planner-editable tools, schema/spec builders,
  and instruction rendering.
- `apps/orchestrator/lib/symphony_elixir/tool_registry.ex` (643 LOC):
  split static registry, dynamic tool execution, tool grants, and policy
  filtering.
- `apps/orchestrator/lib/symphony_elixir/provider/openai_compatible.ex`
  (552 LOC): split request building, response normalization, streaming chunk
  handling, and provider error classification.

## Sequencing For Parallel Agents

- PRs 3, 4, 5, 6, 9, and 10 can run in parallel with low conflict risk.
- PR 1 and PR 8 should agree on whether shared usage extraction lives in
  `SymphonyElixir.UsageExtraction` before either lands.
- PR 2 and PR 7 should agree on whether tool-name normalization remains
  planner-only or becomes a shared helper.
- Each PR should add focused unit tests for the extracted module before moving
  call sites when possible.
- Required pre-commit validation remains:

```bash
cd apps/orchestrator
mix compile --warnings-as-errors
mix test
```
