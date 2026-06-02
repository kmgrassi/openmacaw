# Model-Agnostic Agent Refactor PR Plan

Scope document for making every agent role model/provider agnostic: planning,
coding, manager, and future custom agents.

This is a cross-repo plan. Platform owns user-facing configuration, routing
tables, credential references, and API contracts. Runtime owns provider
adapters, credential resolution at dispatch time, tool-call normalization, and
execution event normalization.

## Existing Direction

The needed pieces are already partially documented, but split across docs:

- Runtime:
  - `apps/orchestrator/docs/model-agnostic-lift-plan.md`
  - `apps/orchestrator/docs/model-provider-swap.md`
  - `apps/orchestrator/docs/backend-adapter-contract.md`
- Platform:
  - `docs/open-questions/oq-03-routing-config-schema.md`
  - `docs/open-questions/oq-04-per-task-model-overrides-credentials.md`
  - `docs/oq-04-credentials-pr-plan.md`
  - `docs/oq-01-plan-format-pr-plan.md`

Those docs agree on the high-level answer:

- routing resolves a runner, model, and credential reference;
- credentials are referenced by ID or alias, never embedded in labels or prompts;
- runtime should execute through backend/provider adapters and normalize events;
- `gateway_config` should not be the hot-path routing source of truth.

The missing piece is a staged plan that makes agent chat, planning draft
generation, and coding execution all use the same provider-neutral path.

## Current Gaps

### Planning Agent

Runtime has `SymphonyElixir.Runner.Planner`, but it is OpenAI Responses-specific:

- fixed Responses API URL;
- OpenAI-style API key resolution;
- OpenAI function-call / structured-output assumptions;
- no provider adapter selection from routing rules.

Recent harness work can draft a plan through a planning agent, but that endpoint
is also intentionally OpenAI-backed because it matches the current runner.

### Coding Agent

Coding currently runs through Codex-specific paths:

- `codex app-server` and Codex protocol events;
- stored credential activation is launchable only for OpenAI/Codex keys;
- provider/model fields exist in agent metadata and UI, but they do not drive a
  provider-neutral execution adapter.

This means a "Coding Agent" is not yet a generic code-capable agent. It is a
Codex-backed coding agent.

### Shared Runtime Surface

The runtime has useful runner abstractions, but provider-specific behavior still
leaks into role runners:

- planning runner knows the upstream LLM API directly;
- coding path knows Codex app-server protocol directly;
- manager-agent work is expected to reuse runners but does not yet have a
  provider-neutral turn executor;
- tool-call events are not normalized across OpenAI, Anthropic,
  OpenAI-compatible, or local providers.

## Target Model

Separate agent role from model/provider backend.

```text
agent role
  planning | coding | manager | custom

execution profile
  runner_kind + provider + model + credential_ref + tool_profile + capabilities

runtime execution
  ProviderAdapter.start_turn(profile, messages, tools)
    -> normalized events
    -> normalized tool calls
    -> normalized usage/errors
```

Examples:

- Planning Agent + Anthropic Claude:
  - role: `planning`
  - runner_kind: `llm_tool_runner`
  - provider: `anthropic`
  - model: `claude-sonnet-...`
  - tool_profile: planner-safe read/create-plan tools

- Coding Agent + OpenAI Codex:
  - role: `coding`
  - runner_kind: `codex`
  - provider: `openai_codex`
  - model: `gpt-5.2`
  - tool_profile: workspace write + PR tools

- Coding Agent + OpenClaw:
  - role: `coding`
  - runner_kind: `openclaw_ws`
  - provider: `openclaw`
  - model: provider-specific
  - tool_profile: delegated through OpenClaw capabilities

## Key Design Decisions

1. **Provider adapters, not role-specific API calls.**
   Planning should not call OpenAI Responses directly. Coding should not be
   synonymous with Codex. Roles supply prompts, tool policy, and constraints;
   adapters own provider protocol.

2. **Routing produces an execution profile.**
   Platform routing should resolve `{runner_kind, provider, model,
   credential_ref}`. Runtime then resolves the credential and instantiates the
   adapter.

3. **Tool calls normalize before execution.**
   OpenAI function calls, Anthropic tool_use blocks, OpenAI-compatible tool
   calls, and local model tool formats should map into one runtime shape:
   `{tool_name, call_id, arguments}`.

4. **Events normalize before UI/logging.**
   Provider streams should become common events like `message.delta`,
   `tool.started`, `tool.completed`, `run.completed`, `run.failed`, and
   `usage.updated`.

5. **Credentials never enter prompts or persisted raw events.**
   OQ-04 remains the rule: credentials resolve by ID or alias at dispatch time,
   live in memory briefly, and are redacted from logs, events, and prompts.

6. **Codex remains the default coding backend.**
   The refactor should preserve today's behavior while making it one adapter
   among several.

7. **Centralize the decision point, not the editable config.**
   Durable config should stay in `agent`, `routing_rule`, `credential`,
   `credential_alias`, and compatibility `gateway_config` rows. The
   `ExecutionProfile` should be computed by one resolver service, then
   optionally snapshotted onto runs/sessions for debugging. Do not introduce an
   editable `execution_profile` table until profiles need independent
   lifecycle, sharing, or versioning.

## Resolver And Routing Scope

The resolver-routing work is the bridge between database configuration and
runtime execution. It should answer one question consistently:

```text
Given this user/workspace/agent/intent/task context, what should execute it?
```

The output is an `ExecutionProfile`; the inputs are existing and newly added
configuration tables.

```text
agent + workspace + intent + optional work item/task
  -> ExecutionProfileResolver
  -> runner_kind + provider + model + credential_ref + tool_profile
```

### Current State

- `agent` already stores identity, workspace, role/type, `model_settings`, and
  `tool_policy`.
- `credential` already stores workspace/user/agent-scoped secret material.
- `gateway_config` and `gateway_config_state` already support legacy runner
  config and config sync state.
- OQ-03 decided that hot-path routing belongs in relational tables rather than
  `gateway_config` JSON.
- OQ-04 decided that routing references `credential_id` or workspace-scoped
  aliases, never secret values or labels.
- Platform PR #126 added the routing/credential FK foundation for
  `routing_rule` and `credential_alias`.

What is missing is a single resolver path used by setup state, agent startup,
planning draft generation, coding launch, and future work item dispatch.

### Resolver Responsibilities

The platform resolver should:

- load the agent and workspace context;
- find enabled matching routing rules by workspace, priority, and match rows;
- support agent-level routing before task-level dispatch is fully generalized;
- resolve credential aliases to credential IDs without returning secret values;
- fall back to current `agent.model_settings` and `gateway_config` runner config
  for backwards compatibility;
- return explicit missing requirements such as `model`, `runner`, `provider`,
  `credential`, or `route`;
- include source metadata for debugging, such as `routing_rule_id`,
  `fallback_used`, and `legacy_gateway_config_used`.

Runtime should consume the resolved profile for launch/dispatch and resolve
secret material only inside runtime-controlled credential resolution paths.

### Central Agent Front Door

Longer term, user chat should be able to enter through one central agent,
likely the Planning Agent. That agent can plan, decide when to delegate, and
dispatch work to Coding, Manager, or custom agents.

This does not change the resolver contract. It changes who calls it:

```text
user message
  -> central planning agent
  -> planner decides delegate/ask/execute
  -> resolver resolves target agent execution profile
  -> target agent/session runs independently
```

The central agent should not own a singleton runtime profile for the workspace.
It should act as an orchestrator that requests per-target-agent or per-work-item
profiles. Each delegated run should carry its own `agent_id`, `session_id`,
`run_id`, resolved runner/provider/model metadata, and credential reference.

Design implications:

- The Planning Agent needs tools for creating plans, creating work items, and
  dispatching or requesting dispatch to another agent.
- Routing must support both direct user-selected agent starts and
  planner-initiated delegated starts.
- The resolver must stay stateless and safe for concurrent calls.
- Running sessions should keep a resolved profile snapshot; routing changes
  affect future dispatches unless explicit hot reload is built.
- Logs/events should identify both the observing/delegating agent and the
  target agent when one agent launches or remediates another.

This keeps the future central-agent UX compatible with distributed execution:
one user-facing planning conversation can fan out into many independently
running agents.

### Database Posture

No new `execution_profile` table is required for the first resolver PRs.

Use the existing/new routing configuration as source of truth:

- `agent`: role, workspace, defaults, tool policy;
- `routing_rule`: runner/model/provider/credential decision;
- `routing_rule_match`: selection conditions;
- `credential_alias`: stable workspace-level credential references;
- `credential`: secret-bearing credential row;
- `gateway_config`: compatibility and opaque runtime policy.

Likely small migration follow-ups:

- add routing match kinds for `agent_id`, `agent_type`, and `intent` if the
  current `routing_rule_match` shape cannot express them cleanly;
- add generated Supabase type sync after each migration;
- add optional run/session snapshot fields for the resolved profile once the
  runtime is consuming it.

Persisted snapshots should be diagnostic records, not the editable source of
truth.

### Rollout Shape

This should be multiple small PRs, not one large cross-repo implementation:

1. Platform contract and resolver read model.
2. Platform resolver API/service with legacy fallback.
3. Platform setup/start paths consume resolver output.
4. Runtime launcher/start paths accept and log resolved profile metadata.
5. Runtime provider adapters gradually replace role-specific provider calls.

That sequence lets current Codex/OpenAI behavior keep working while making the
new routing path visible and testable early.

## Proposed Shared Contracts

### Platform Execution Profile

Shared TypeScript contract, later mirrored in runtime types:

```ts
type AgentRole = "planning" | "coding" | "manager" | "custom";

type ExecutionProfile = {
  agentId: string;
  workspaceId: string;
  role: AgentRole;
  runnerKind: "llm_tool_runner" | "codex" | "openclaw_ws" | "openclaw_http_sse" | "computer_use";
  provider: "openai" | "anthropic" | "openai_compatible" | "openai_codex" | "openclaw" | string;
  model: string;
  credentialRef: { type: "credential_id" | "alias"; value: string } | null;
  toolProfile: "planning" | "coding" | "manager" | "none";
  capabilities: {
    streaming: boolean;
    toolCalls: boolean;
    workspaceWrite: boolean;
    structuredOutput: boolean;
    interrupt: boolean;
  };
};
```

### Runtime Provider Adapter

Elixir behavior shape:

```elixir
@callback validate_profile(profile :: map()) :: :ok | {:error, term()}
@callback start_turn(profile :: map(), input :: map(), opts :: keyword()) ::
  {:ok, Enumerable.t()} | {:error, term()}
@callback normalize_event(provider_event :: term()) ::
  {:ok, map()} | :ignore | {:error, term()}
@callback supports?(capability :: atom()) :: boolean()
```

Provider adapters should not decide whether an agent is allowed to use a tool.
They only expose tool-call protocol support. Runtime tool policy remains the
authorization boundary.

## Implementation Sequence

### PR 1 — Platform: Execution Profile Contract

Repository: `parallel-agent-platform`

Deliverables:

- Add shared `ExecutionProfile` contract under `contracts/`.
- Add provider/runner enums that include OpenAI, Anthropic, OpenAI-compatible,
  Codex, and OpenClaw without treating them as the same concept.
- Add helpers that derive provider from model only as a fallback, not as source
  of truth.
- Document that agent role and execution backend are separate.
- No database migration. This PR defines the computed contract, not a new
  persisted profile table.

Acceptance:

- Existing agent/setup contracts continue to parse.
- New contract has unit tests for planning/coding profiles with different
  providers.

### PR 2 — Platform: Routing Resolver API Shape

Repository: `parallel-agent-platform`

Deliverables:

- Implement or stub a service that resolves an agent/task into an
  `ExecutionProfile`.
- Source runner/provider/model/credential from `routing_rule` and
  `credential_alias` when available.
- Fall back to current agent `model_settings` and existing default-agent setup.
- Return explicit "missing credential/model/runner" reasons.
- Add a small routing migration only if current match rows cannot express
  `agent_id`, `agent_type`, or `intent`.
- Do not return credential secret material from the resolver.

Acceptance:

- A Planning Agent can resolve to Anthropic while Coding Agent resolves to
  Codex in the same workspace.
- Existing setup state still shows actionable missing requirements.
- Resolver unit tests cover route match, alias resolution, legacy fallback, and
  missing-requirement responses.

### PR 3 — Platform: Setup And Start Use The Resolver

Repository: `parallel-agent-platform`

Deliverables:

- Update setup/auth-state and stored-agent start paths to call the resolver
  instead of reconstructing credential/model/gateway checks separately.
- Surface resolver source metadata in API responses for debugging.
- Preserve existing `gateway_config` fallback behavior while routing rules are
  adopted.

Acceptance:

- Default Planning and Coding Agents can show different providers/models from
  the same workspace.
- Missing credential/model/runner UI is driven by resolver output, not by a
  parallel check.
- Existing setup tests continue to pass with legacy gateway config fixtures.

### PR 4 — Platform: Credential Alias/Reference UI and API

Repository: `parallel-agent-platform`

Deliverables:

- Build on OQ-04 credential alias work.
- Let users attach existing credentials by alias/reference to agent execution
  profiles without copying secrets.
- Keep provider list broad, with OpenAI and Anthropic pinned at top in UI.

Acceptance:

- One credential can be reused across planning/coding/manager when provider
  and runner support it.
- A credential selected for Anthropic does not appear as Codex-launchable unless
  the selected runner supports it.

### PR 5 — Runtime: Consume Resolved Execution Profiles

Repository: `parallel-agent-runtime`

Deliverables:

- Accept resolved execution profile metadata on launcher/start and dispatch
  paths where applicable.
- Log runner/provider/model/profile source metadata without secrets.
- Keep runtime-side credential resolution responsible for decrypting/using
  secret material.
- Preserve the current Codex/OpenAI path as the default fallback.

Acceptance:

- Runtime startup logs identify the resolved runner/provider/model.
- A missing or unsupported runner/provider fails with a typed error.
- No provider key or secret appears in logs or websocket events.

### PR 6 — Runtime: Provider Adapter Behavior and Normalized Events

Repository: `parallel-agent-runtime`

Deliverables:

- Add provider adapter behavior.
- Add normalized LLM event structs/maps.
- Add normalized tool-call shape.
- Wrap the current OpenAI Responses planning implementation as
  `Provider.OpenAIResponses`.

Acceptance:

- Existing planning runner tests pass through the adapter.
- Tool-call execution still respects planner-safe tool policy.

### PR 7 — Runtime: Anthropic Provider Adapter

Repository: `parallel-agent-runtime`

Deliverables:

- Add `Provider.AnthropicMessages`.
- Normalize Anthropic content blocks and `tool_use` into runtime tool calls.
- Normalize usage and stop reasons.
- Map provider errors into retryable/auth/capacity/provider-unavailable
  categories.

Acceptance:

- A planner turn can use Anthropic with planner tools in tests.
- Invalid/expired Anthropic credentials produce auth errors, not generic 500s.

### PR 8 — Runtime: OpenAI-Compatible Provider Adapter

Repository: `parallel-agent-runtime`

Deliverables:

- Add `Provider.OpenAICompatible`.
- Support configurable base URL, model, and bearer credential.
- Use OpenAI-compatible chat/tool-call protocol as the first target.

Acceptance:

- Local vLLM/Ollama/LM Studio-style endpoint can be configured without code
  changes.
- Adapter reports capability limits if structured output or tool calls are not
  available.

### PR 9 — Runtime: Refactor Planner Runner to Execution Profiles

Repository: `parallel-agent-runtime`

Deliverables:

- Replace direct OpenAI calls in `Runner.Planner` and plan-draft harness with
  execution profile resolution.
- Keep planner instructions/tool profile role-owned.
- Let provider adapter own API format.

Acceptance:

- Planning Agent can draft/create plans with OpenAI or Anthropic by changing
  profile config only.
- Planner read/write tool restrictions are unchanged.

### PR 10 — Runtime: Refactor Coding Launch to Execution Profiles

Repository: `parallel-agent-runtime`

Deliverables:

- Treat current Codex app-server path as one coding adapter/backend.
- Stop assuming Coding Agent means OpenAI/Codex credential.
- Route coding work through execution profile resolution.
- Preserve current Codex behavior as default.

Acceptance:

- Current Coding Agent chat still works unchanged.
- A non-Codex coding backend can be configured behind the same agent role, even
  if first non-Codex backend is OpenClaw.

### PR 11 — Platform + Runtime: End-to-End Model-Agnostic Smoke Harness

Repositories: both

Deliverables:

- Local/manual smoke path for:
  - Planning Agent on provider A creates a plan.
  - User approves selected tasks.
  - Coding Agent on provider B receives the handoff.
- Add API-level test fixtures that do not require live provider calls.

Acceptance:

- Browser test can demonstrate planning and coding agents using different
  provider/model settings.
- Logs show execution profile and provider adapter names, with no secrets.

## Migration Strategy

1. Keep existing agent rows and `model_settings` working.
2. Introduce `ExecutionProfile` as a computed contract first.
3. Add routing tables/aliases as the source of truth.
4. Move runtime runners one at a time behind adapters.
5. Make UI prefer routing/profile settings after the backend can execute them.
6. Remove direct provider assumptions only after adapter-backed paths are
   covered by tests.

## Provider-Agnostic Acceptance Criteria

The refactor is complete when:

- every agent role resolves an `ExecutionProfile` before execution;
- no role runner calls an LLM provider API directly;
- OpenAI, Anthropic, and OpenAI-compatible providers share normalized tool-call
  and event handling;
- Coding Agent can run through Codex by default but is not hard-coded to Codex;
- Planning Agent can run through at least OpenAI and Anthropic;
- credentials are referenced by ID/alias and redacted through dispatch;
- UI can show provider/model/credential state without implying provider equals
  agent type.

## Explicit Non-Goals

- Do not rewrite all runner backends at once.
- Do not remove Codex as the default coding path.
- Do not require OpenTelemetry or a third-party tracing platform.
- Do not store raw provider event streams unless a later logging decision
  requires it.
- Do not let planners choose arbitrary credentials in labels or prompts.

## Open Questions

- Should the first provider-neutral coding backend after Codex be OpenClaw or an
  LLM-tool-runner with workspace-write tools?
- Should structured output be required for planning, or should adapters support
  retry/repair for providers without strict JSON schema support?
- Should manager agents use the same `llm_tool_runner` as planning agents with a
  manager tool profile, or get a separate runner kind for scheduling semantics?
- How much of routing should be task-level now versus agent-level until task
  deprecation work is complete?
