# Unified Execution Profile - Runtime Scope

Status: scoping. This document is the runtime-side companion to
`parallel-agent-platform/docs/active/unified-execution-profile-scope.md`.

## Goal

Remove runtime-side execution-profile fallback reads from `gateway_config`
after the platform moves model/provider/credential/runner selection to the
relational execution-profile source of truth.

Runtime should treat execution-profile routing as platform-owned data:

```text
model/provider/credential/runner selection = routing_rule source of truth
```

`gateway_config` remains valid for runtime-specific knobs that are not the
execution profile, such as manager cadence and due-task query configuration.
This scope is only about deleting execution-profile fallback paths.

## Runtime Contract Decisions

These decisions make the runtime scope concrete enough for implementation PRs:

- Canonical runner kinds are the runtime allowlist values:
  `codex`, `openclaw`, `computer_use`, `manager`, `planner`, and
  `local_relay`. Existing support for `claude_code` and
  `local_model_coding` remains valid while those runners exist. Do not add
  canonical `llm_tool_runner` values; platform should send `manager` or
  `planner` after applying its `(agentType, provider)` policy.
- Canonical providers are the runtime allowlist values in
  `SymphonyElixir.Schema.ExecutionProfile`: `openai`, `openai_codex`,
  `codex`, `anthropic`, `openai_compatible`, `openclaw`, `computer_use`, and
  `local`.
- Platform may send camelCase JSON over HTTP (`runnerKind`, `credentialRef`,
  `adapterConfig`, etc.). Runtime normalizes that wire shape to snake_case at
  the boundary. That is key normalization, not a legacy execution-profile
  fallback.
- A runnable profile must include `runner_kind` and `provider`. `model`,
  `credential_ref`, `adapter_config`, `capabilities`, and `source_metadata`
  are optional unless the platform policy matrix requires them for a given
  provider.
- Runtime must never infer model/provider/credential/runner from
  `gateway_config.runners`, `gateway_config.codex`, or
  `stored_agent.model_settings` after the migration cutover.
- Manager cadence, due-task query settings, and scheduler runtime knobs are
  not execution-profile fields. They stay on the manager runtime config
  surface until the platform/DB migration moves them to a dedicated table.

## Cross-Repo Sequence

The runtime implementation PR is gated on the platform and DB phases that make
`routing_rule` complete enough for every runtime start path.

1. `parallel-agent-platform` adds the unified execution-profile contract,
   picker, and endpoint.
2. `parallel-agent-platform` updates agent start calls to forward a resolved
   profile in `resolved_execution_profile` until runtime can read every field
   it needs directly from `routing_rule`.
3. `harper-server` applies the storage migration that makes routing-rule data
   the sole execution-profile source of truth and moves manager-only runtime
   knobs out of `gateway_config.runners.manager` if the platform scope chooses
   a new table.
4. `parallel-agent-runtime` deletes gateway-config execution-profile fallback
   reads and requires a forwarded profile or a relational routing-rule profile.
5. `parallel-agent-platform` deletes its final gateway-config resolver
   fallback after the runtime change is deployed.

Do not add dual-format compatibility. If a runtime reader needs a new field,
add it to the canonical contract and update the platform producer in the same
PR series.

## Canonical Runtime Shape

Runtime stores and logs the normalized snake_case shape:

```elixir
%{
  "agent_id" => "agent-uuid",
  "workspace_id" => "workspace-uuid",
  "runner_kind" => "codex",
  "provider" => "openai",
  "model" => "openai/gpt-5.5",
  "role" => "coding",
  "tool_profile" => "coding",
  "credential_ref" => %{"kind" => "credential_id", "id" => "credential-uuid"},
  "adapter_config" => %{},
  "capabilities" => %{},
  "source_metadata" => %{"source" => "routing_rule", "routing_rule_id" => "rule-uuid"}
}
```

Required for runtime validation:

| Field | Required | Runtime use |
| --- | --- | --- |
| `runner_kind` | Yes | Selects the runner module. |
| `provider` | Yes | Selects provider-specific runner config and logging. |
| `model` | Provider-dependent | Passed to runners that need an explicit model. |
| `credential_ref` | Provider-dependent | Resolved by platform or runtime credential resolver, depending on runner. |
| `adapter_config` | No | Provider-specific settings such as `base_url`; secrets must be redacted. |
| `source_metadata` | No | Non-secret diagnostics: source, routing rule id, version/hash. |

## Current Runtime Surfaces

### Execution Profile Normalization

Files:

- `apps/orchestrator/lib/symphony_elixir/execution_profile.ex`
- `apps/orchestrator/test/symphony_elixir/execution_profile_test.exs`

Current behavior:

- `normalize_from_config/1` accepts explicit `execution_profile`,
  `resolved_execution_profile`, or nested `runtime.execution_profile`.
- If none is present, it derives a legacy fallback profile from runner/codex
  config and marks `source_metadata.fallback_used = true`.

Needed change:

- Remove the legacy fallback profile for launcher/orchestrator start paths
  once the platform always forwards or persists the canonical profile.
- Change missing explicit profiles to a typed error, recommended as
  `{:missing_execution_profile, :launcher_start}` for launch/start paths and
  `{:missing_execution_profile, :orchestrator_config}` for generated config
  helpers.
- Keep validation, sanitization, logging helpers, key normalization, and
  runner-module selection.
- Remove `fallback_profile/1`, `fallback_runner_kind/1`,
  `fallback_model/1`, `fallback_provider/3`, and stored-agent model fallback
  helpers once no call path needs them.
- Remove `llm_tool_runner` family normalization after the platform policy sends
  canonical `manager` and `planner` runner kinds.
- Update tests that assert `fallback_used` so missing profiles fail clearly
  instead of silently becoming Codex defaults.

### Routing Rule Reader

Files:

- `apps/orchestrator/lib/symphony_elixir/gateway/agent_execution_profile.ex`
- `apps/orchestrator/test/symphony_elixir/gateway/agent_execution_profile_test.exs`

Current behavior:

- Chat-time resolution already reads `routing_rule` and `routing_rule_match`
  via PostgREST.
- It returns `{:error, :not_found}` when no rule matches.
- It currently selects `id,priority,runner_kind,provider,model,enabled,
  workspace_id` only.

Needed change:

- Keep this as the runtime-owned relational reader for gateway chat paths.
- Extend the select list to return the complete runtime profile fields once
  they exist in storage: `credential_ref` or `credential_id`, `adapter_config`
  or `base_url`, `capabilities`, and source metadata needed for diagnostics.
- Normalize the relational row through `ExecutionProfile.normalize_from_config/1`
  or a shared explicit-profile validator so gateway and launcher reject the
  same invalid values.
- Do not reintroduce gateway-config fallback when no routing rule matches.
- Surface no-match as `routing_rule_not_found` in gateway errors/logs.

### Launcher Start Path

Files:

- `apps/orchestrator/lib/symphony_elixir/launcher/agent_starter.ex`
- `apps/orchestrator/lib/symphony_elixir/launcher/server.ex`
- `apps/orchestrator/test/symphony_elixir/launcher/*`
- `apps/orchestrator/test/symphony_elixir/launcher/server_test.exs`

Current behavior:

- `AgentStarter.resolve_and_validate_agent_config/2` fetches agent-scoped
  `gateway_config`, then workspace-scoped `gateway_config`, then local
  template fallback.
- If launch params include a forwarded `resolved_execution_profile`, it merges
  that profile into the config before normalization.
- `Launcher.Server` normalizes the merged config for logging before starting
  the orchestrator.

Needed change:

- Keep `gateway_config` reads for launch config that is not execution-profile
  routing, such as tracker and workflow settings.
- Require `resolved_execution_profile` in platform-triggered start requests
  until the launcher has a relational reader that returns a complete canonical
  profile.
- After the relational reader exists, allow launcher start to resolve the
  canonical profile from `routing_rule` using `(agent_id, workspace_id)`.
- Treat local `:agent_launch_template` as development scaffolding only. If it
  lacks an explicit `execution_profile`, production agent start should fail
  with `missing_execution_profile` instead of deriving Codex defaults.
- Update invalid-config errors so missing execution profile points to the
  platform execution-profile route or routing-rule data, not to creating a
  gateway-config runner entry.

### Orchestrator Starter

Files:

- `apps/orchestrator/lib/symphony_elixir/orchestrator/starter.ex`
- `apps/orchestrator/test/symphony_elixir/orchestrator/*`

Current behavior:

- Builds a generated server config and writes normalized execution profile
  data into the runtime config file.
- Falls back to an empty execution profile when normalization fails in helper
  paths that build config snippets.

Needed change:

- Preserve config generation and redaction.
- Stop treating missing execution-profile data as a valid source for
  model/provider/runner selection.
- If a helper must emit a config snippet without a profile, omit
  `execution_profile` and log the typed missing-profile reason. Do not write
  `{}` as a successful profile.
- Keep local-template fallback limited to development-only launch scaffolding,
  not production execution-profile resolution.

### Observability

Files:

- `apps/orchestrator/lib/symphony_elixir/agent_runner.ex`
- `apps/orchestrator/lib/symphony_elixir/runtime_log.ex`
- tests that assert `profile_fallback_used` or `fallback_used`

Needed change:

- Remove or rename fallback-specific log fields when fallback support is
  deleted.
- Add clear lifecycle/runtime log fields for `missing_execution_profile`,
  `invalid_execution_profile`, and `routing_rule_not_found`.
- Preserve non-secret `source_metadata` fields such as routing rule id,
  config hash/version, profile source, and trace id.
- Keep existing redaction guarantees for credential references and adapter
  config.

## Runtime PR Plan

### RUNTIME-1 - Document And Gate The Contract

- Land this scoping doc.
- Update or annotate stale runtime docs that describe `gateway_config` as the
  source for model/provider/credential/runner selection:
  - `docs/agent-config-error-ux-plan.md`
  - `apps/orchestrator/docs/manager-agent-default-login-pr-plan.md`
  - `apps/orchestrator/docs/model-agnostic-agent-refactor-pr-plan.md`
  - `apps/orchestrator/docs/planning-agent-scope.md`
- Before implementation starts, confirm the platform PR that sends
  `resolved_execution_profile` on `POST /api/agents/:id/start`.
- Before fallback deletion, confirm the harper-server migration that makes
  `routing_rule` contain the complete runtime shape.

### RUNTIME-2 - Remove Legacy Execution-Profile Fallbacks

- Change `ExecutionProfile.normalize_from_config/1` so missing explicit
  execution-profile data returns a typed error for launcher/orchestrator start
  paths.
- Keep `resolve_coding/3` support for explicitly supplied work-item metadata
  or runner config profiles during the transition. Remove Codex default
  derivation from platform-configured paths first; remove the
  `legacy_coding_profile/2` agent-runner fallback only after work-item dispatch
  always carries an explicit profile.
- Remove `fallback_used` source metadata assertions and replace them with
  missing-profile assertions.
- Update launcher and orchestrator tests that currently assert
  `fallback_used`.

### RUNTIME-3 - Tighten Launcher And Gateway Errors

- Update `AgentStarter` errors to distinguish missing tracker config from
  missing execution profile.
- Ensure chat-time `Gateway.AgentExecutionProfile.resolve/2` failures surface
  as routing-rule errors, not gateway-config instructions.
- Validate routing-rule rows through the same execution-profile schema used by
  forwarded profiles.
- Keep manager cadence/due-task query config reads intact.

### RUNTIME-4 - Smoke And Regression Coverage

- Add or update tests for:
  - forwarded execution profile succeeds;
  - routing-rule-backed profile succeeds;
  - missing routing rule fails clearly;
  - gateway_config runner/model fields are ignored for execution-profile
    routing after the migration;
  - manager-specific runtime knobs still read from their config surface.

## Outstanding Questions

These are the remaining decisions to settle with the platform/DB work before
runtime fallback deletion merges:

| Question | Proposed answer | Owner / gate |
| --- | --- | --- |
| Does platform send `llm_tool_runner` or canonical runtime runner kinds? | Platform should send canonical `manager` and `planner`. Runtime should not add `llm_tool_runner` to the canonical allowlist. | Platform Phase 1 policy table before runtime RUNTIME-2. |
| Which field carries `openai_compatible` base URL? | Use `adapter_config.base_url` in the runtime profile; do not add a top-level runtime field unless the platform contract changes everywhere. | Platform unified endpoint + harper-server schema. |
| Does chat-time routing read a full profile or only runner/provider/model? | It must read a full profile before gateway-config fallback is deleted; otherwise provider credentials/base URL can diverge between launcher and chat. | harper-server migration and `Gateway.AgentExecutionProfile` update. |
| When can `legacy_coding_profile/2` be deleted? | After manager/planner/coding work-item dispatch always supplies `execution_profile` in opts or work-item metadata. Until then, delete launcher/orchestrator fallback first and keep this narrower agent-runner transition scoped separately. | Runtime RUNTIME-2 follow-up if dispatch is not ready. |
| Where do manager cadence and due-task query settings live after storage collapse? | Keep reading the current manager runtime config surface until platform/DB creates the dedicated table. Do not encode these settings in `ExecutionProfile`. | Platform Phase 4 / harper-server migration. |
| Is `agent.model_settings.primary` ever a runtime fallback after cutover? | No. Platform/DB should backfill routing rules for older agents, then runtime treats missing routing data as `routing_rule_not_found`. | harper-server backfill before runtime RUNTIME-2. |

## Verification

- `cd apps/orchestrator && mix compile --warnings-as-errors`
- `cd apps/orchestrator && mix test`
- Focused tests:
  - `test/symphony_elixir/execution_profile_test.exs`
  - `test/symphony_elixir/gateway/agent_execution_profile_test.exs`
  - launcher/orchestrator start-path tests touched by the implementation

For implementation PRs that touch live launcher, database access, gateway, or
manager scheduling behavior, also run the repo-level runtime smoke described
in `AGENTS.md`.
