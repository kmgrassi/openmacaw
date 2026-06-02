# Refactoring Candidates

This list focuses on files that are large, carry multiple responsibilities, or have repeated helper clusters that would be easier to test and maintain behind smaller modules. Line counts are approximate from the current worktree. Generated files such as `supabase/generated/types.ts` are intentionally excluded.

## 1. `apps/orchestrator/lib/symphony_elixir/orchestrator.ex` (~1,729 lines)

**Why:** The GenServer owns polling, dispatch selection, running-worker reconciliation, retry scheduling, worker-host capacity, snapshot shaping, Codex token accounting, rate-limit extraction, and dashboard-facing state.

**Refactor direction:** Keep the GenServer focused on message handling and state transitions. Extract pure policy/calculation modules:

- `SymphonyElixir.Orchestrator.DispatchPolicy` for issue sorting, state eligibility, blockers, assignee routing, and slot checks.
- `SymphonyElixir.Orchestrator.RetryPolicy` for retry metadata, backoff, stale retry tokens, and continuation retry decisions.
- `SymphonyElixir.Orchestrator.CodexTelemetry` for token deltas, rate-limit extraction, session completion totals, and payload path helpers.
- `SymphonyElixir.Orchestrator.WorkerCapacity` for host selection and per-host capacity accounting.

**First step:** Move the `*_for_test` wrappers and their pure private implementations around dispatch eligibility/sorting into a dispatch policy module, then point existing tests at that module directly.

## 2. `apps/orchestrator/lib/symphony_elixir/codex/app_server.ex` (~1,217 lines)

**Why:** This module handles session startup, local vs remote port launch, JSON-RPC message sending, line-buffered stream parsing, turn lifecycle translation, approval handling, dynamic tool execution, user-input auto-answering, logging metadata, and policy normalization.

**Refactor direction:** Split protocol mechanics from Codex-specific policy decisions:

- `Codex.AppServer.PortLauncher` for local/remote launch commands, workspace validation, and port metadata.
- `Codex.AppServer.Protocol` for `send_message/2`, response matching, line buffering, JSON decoding, and malformed stream handling.
- `Codex.AppServer.TurnEvents` for `handle_turn_method/5`, event emission, and `needs_input?/2`.
- `Codex.AppServer.Approvals` for command/file/tool approval and non-interactive user-input answers.

**First step:** Extract approval and tool-input handling. It is a dense, mostly self-contained middle section and has clear behavioral tests in `app_server_test.exs`.

## 3. `apps/orchestrator/lib/symphony_elixir/status_dashboard.ex` (~1,149 lines)

**Why:** The GenServer, terminal render throttling, snapshot fetching, table formatting, rate-limit formatting, token-throughput graphing, ANSI styling, and environment-driven enablement flags are all in one file.

**Refactor direction:** Preserve `StatusDashboard` as the process and split rendering/math helpers:

- `StatusDashboard.Renderer` for `format_snapshot_content/3`, running rows, retry rows, headers, and project/dashboard URL lines.
- `StatusDashboard.TokenThroughput` for rolling TPS, samples, pruning, and graph buckets.
- `StatusDashboard.RateLimitFormatter` for rate-limit bucket and credit formatting.
- `StatusDashboard.Terminal` for terminal width, ANSI/color helpers, output enablement, and interactive stdio checks.

**First step:** Move token-throughput functions into a pure module. They already have direct tests and are not coupled to GenServer state.

## 4. `apps/orchestrator/lib/symphony_elixir/launcher/server.ex` (~1,041 lines)

**Why:** The launcher server combines process registry behavior, orchestrator lifecycle, persisted state restore, heartbeat emission, engine-instance writes/reconciliation, gateway-config resolution, credential injection, and launch-config normalization.

**Refactor direction:** Keep orchestration lifecycle in the GenServer, but extract side-effect-heavy adapters:

- `Launcher.Persistence` for state file read/write and restored entry serialization.
- `Launcher.EngineInstanceSync` for write/update/reconcile/heartbeat dispatch.
- `Launcher.AgentLaunchConfig` for gateway config resolution, local fallback, stored-agent injection, credentials, and plan handoff.
- `Launcher.Entry` for entry serialization and small field-normalization helpers.

**First step:** Extract gateway/credential launch config resolution from `resolve_launch_config/1` through `record_gateway_apply/4`; that section is cohesive and likely to grow independently from process lifecycle.

## 5. `apps/orchestrator/lib/symphony_elixir/status_dashboard/codex_message.ex` (~887 lines)

**Why:** A single formatter maps many event families: native Codex methods, wrapper events, dynamic tool events, approvals, streaming deltas, rate-limit/account updates, payload sanitization, and fallback payload summaries.

**Refactor direction:** Convert event families into small formatter modules behind one public `humanize/1` facade:

- `CodexMessage.NativeMethods`
- `CodexMessage.WrapperEvents`
- `CodexMessage.DynamicToolEvents`
- `CodexMessage.PayloadSummary`

**First step:** Extract wrapper-event handling. The `humanize_wrapper_event/2` clauses form a natural block and can be tested with the existing dashboard humanization cases.

## 6. `apps/orchestrator/lib/symphony_elixir/config/schema.ex` (~781 lines)

**Why:** The file mixes Ecto schema definitions, top-level parsing, final setting normalization, secret/env resolution, path defaults, sandbox policy resolution, state-limit validation, and changeset error formatting.

**Refactor direction:** Keep the Ecto schemas and `parse/1` facade here, then move reusable logic out:

- `Config.SecretResolver` for `$VAR` resolution and secret normalization.
- `Config.PathResolver` for workspace/cache/artifact defaults and local path expansion.
- `Config.SandboxPolicy` for turn/runtime sandbox policy defaults and explicit-policy passthrough.
- `Config.Errors` for flattening and formatting changeset errors.

**First step:** Extract sandbox policy resolution because it is already exposed through public functions and has focused test coverage.

## 7. `apps/orchestrator/lib/symphony_elixir/manager/tools.ex` (~774 lines)

**Why:** The tool registry, JSON schemas, argument validation, PostgREST row manipulation, routing lookup, dispatch idempotency, escalation row construction, event summarization, and result encoding all live together.

**Refactor direction:** Move each tool implementation behind a small command module and keep this file as the registry/dispatcher:

- `Manager.Tools.DispatchRunner`
- `Manager.Tools.EscalateToHuman`
- `Manager.Tools.WorkItemState`
- `Manager.Tools.ArtifactState`
- `Manager.Tools.Events`
- `Manager.Tools.Schema`
- `Manager.Tools.Result`

**First step:** Extract JSON schema construction into `Manager.Tools.Schema`. It is at the top of the file, easy to verify, and reduces noise before moving behavior.

## 8. `apps/orchestrator/lib/symphony_elixir/agent_runner.ex` (~685 lines)

**Why:** The runner coordinates workspace creation, runner config resolution, multi-turn continuation, worker-host selection, issue-state refresh, broker logging, token accumulation, message forwarding, and issue metadata helpers.

**Refactor direction:** Treat the current module as the top-level runner workflow and extract stateful concerns:

- `AgentRunner.TurnLoop` for `run_runner_turns/8`, continuation prompts, max-turn handling, and issue refresh decisions.
- `AgentRunner.TokenAccumulator` for snapshot process, usage extraction, and token field lookup.
- `AgentRunner.BrokerRun` for begin/update/finalize broker logging and terminal reason mapping.
- `AgentRunner.RunnerConfig` for execution profile and runner-specific setting merging.

**First step:** Move token accumulation. It is a compact helper subsystem with testable input/output behavior and little dependency on runner startup.

## 9. `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex` (~675 lines)

**Why:** The socket handles websocket protocol routing, scope validation, session-thread persistence, runner startup, message logging, notification translation, session list rows, delta extraction, JSON-RPC response encoding, and error mapping.

**Refactor direction:** Leave websocket callbacks in place and extract request handlers and protocol helpers:

- `GatewaySocket.Requests` for `"connect"`, `"chat.send"`, `"chat.abort"`, `"models.list"`, and session/config methods.
- `GatewaySocket.Scope` for query parsing, session key derivation, validation, and agent fetch.
- `GatewaySocket.Notifications` for runner-event translation and assistant/user message persistence.
- `GatewaySocket.JsonRpc` for response/error encoding.

**First step:** Extract delta and notification translation. The current `extract_delta*`, `delta_paths/0`, and `maybe_translate_runner_event/4` functions are cohesive and can be verified with existing gateway socket tests.

## 10. `apps/orchestrator/lib/symphony_elixir/linear/client.ex` (~676 lines)

**Why:** The Linear client includes GraphQL query text, HTTP request/response handling, pagination, mutation decoding, issue normalization, assignee routing filters, blocker extraction, error summarization, and datetime/priority parsing.

**Refactor direction:** Split transport, query workflows, and normalization:

- `Linear.Transport` for `graphql/3`, payload/header building, request execution, status classification, and response decoding.
- `Linear.IssueQueries` for candidate/state query pagination and page merging.
- `Linear.IssueNormalizer` for labels, blockers, assignees, priority, datetime parsing, and worker-assignment filtering.
- `Linear.Mutations` for create/update issue result decoding.

**First step:** Extract issue normalization and assignee matching. This reduces the size of the client while keeping transport behavior unchanged.

## Honorable Mentions

- `apps/orchestrator/lib/symphony_elixir/provider/openai_compatible.ex` (~516 lines): split request building, response normalization, streaming chunk normalization, and provider error classification.
- `apps/orchestrator/lib/symphony_elixir/provider/anthropic_messages.ex` (~511 lines): same shape as OpenAI-compatible provider; consider shared provider error and runner-event helpers where the semantics match.
- `apps/orchestrator/lib/symphony_elixir/workspace.ex` (~539 lines): separate local/remote workspace operations, lifecycle hooks, repository bootstrap, and shell escaping.
- `apps/orchestrator/lib/symphony_elixir/worker_bridge/server.ex` (~493 lines): split GenServer session lifecycle from credential/env resolution, identity workspace validation, launch spec construction, and port management.
- Large test files such as `core_test.exs`, `orchestrator_status_test.exs`, `app_server_test.exs`, and `workspace_and_config_test.exs` should follow the production splits. Moving tests before production code may reduce readability because the current test modules mirror today's broad modules.
