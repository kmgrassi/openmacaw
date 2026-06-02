# Agent Tool Grant Data Model - Runtime Scope

## Goal

Update Runtime for the Harper Server / Platform tool policy model where:

- `tool_policy_template` rows are write-time presets.
- `agent_tool_grant` rows are the runtime source of truth.
- Runtime receives or resolves effective tool definitions, never persistent
  agent-template subscriptions.

The runtime invariant:

```text
model-facing tools for a turn = enabled tool definitions from agent_tool_grant
```

Templates may explain provenance, but they do not affect runtime resolution
unless Platform has already converted them into `agent_tool_grant` rows.

## Current Runtime Surfaces

### Tool Registry

Files:

- `apps/orchestrator/lib/symphony_elixir/tool_registry.ex`
- `apps/orchestrator/test/symphony_elixir/tool_registry_test.exs`
- `docs/unified-tool-contract-scope.md`
- `docs/unified-tool-contract-runtime-prs.md`

Needed changes:

- Keep registry as the catalog/dispatcher for runtime-owned tools.
- Remove stale documentation and tests that describe resolution as legacy
  bundle arithmetic.
- If Runtime resolves from DB directly, `resolve_for_agent/1` must read
  `agent_tool_grant` includes only, joined to `tool`.
- `execute/4` should continue enforcing the allowed tool names passed into the
  turn. The allowlist should be derived from effective grants.

### Planner Tools

Files:

- `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`
- `apps/orchestrator/lib/symphony_elixir/planner/repository_tools.ex`
- `apps/orchestrator/lib/symphony_elixir/runner/planner.ex`
- `apps/orchestrator/test/symphony_elixir/runner/planner_test.exs`
- `apps/orchestrator/test/symphony_elixir/integration/planner_local_smoke_test.exs`
- `apps/orchestrator/docs/planner-tool-contract.md`
- `apps/orchestrator/docs/planning-agent-readonly-architecture.md`

Needed changes:

- Stop assuming all planning agents always get the full planner tool set.
- Tests should build the model-facing tool list from effective grants.
- Planner local relay tests should verify that removing a grant removes the
  tool from the next provider request.
- Planner DB/repo tool execution should still reject calls not included in the
  turn allowlist.

### Manager Tools

Files:

- `apps/orchestrator/lib/symphony_elixir/manager/tools.ex`
- `apps/orchestrator/lib/symphony_elixir/runner/manager.ex`
- `apps/orchestrator/test/symphony_elixir/manager/tools_test.exs`
- `apps/orchestrator/test/symphony_elixir/runner/manager_test.exs`
- `apps/orchestrator/test/symphony_elixir/integration/manager_local_smoke_test.exs`
- `apps/orchestrator/docs/manager-agent.md`

Needed changes:

- Stop treating the manager bundle as implicit runtime truth.
- Manager tool specs should come from the effective grant set for that manager
  agent.
- Manager tests that assert `ToolRegistry.bundle(:manager)` should be split:
  registry membership tests can still assert the catalog, while runner tests
  should assert grant-derived tool availability.
- Tool calls such as `snooze`, `dispatch_runner`, and `merge_pr` must remain
  deny-by-default unless included in the current grant-derived allowlist.

### Local Relay And Runtime-Managed Tools

Files:

- `apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex`
- `apps/orchestrator/lib/symphony_elixir/runner/local_model_coding.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/model_client/local_relay.ex`
- `apps/orchestrator/lib/symphony_elixir/planner/model_client/local_relay.ex`
- `apps/orchestrator/test/symphony_elixir/runner/local_relay_tool_test.exs`
- `apps/orchestrator/docs/local-relay-protocol.md`
- `apps/orchestrator/docs/local-relay-protocol.schema.json`
- `apps/orchestrator/docs/local-model-coding-tool-contract.md`

Needed changes:

- Dispatch frames should carry only effective tool definitions and provider tool
  specs.
- Do not send template selections as runtime policy.
- If we add provenance to the frame, it should be informational only:
  `grant_source`, `source_tool_template_id`, or similar.
- Helper-managed and runtime-managed routing should continue to be based on
  each effective tool definition's execution metadata, not on agent role.

### Execution Profile And Config

Files:

- `apps/orchestrator/lib/symphony_elixir/schema/execution_profile.ex`
- `apps/orchestrator/test/symphony_elixir/schema/execution_profile_test.exs`
- `docs/model-agnostic-agent-config-plan.md`
- `docs/local-model-readiness-runtime-prs.md`

Needed changes:

- `tool_profile` remains a creation/defaulting hint only if it remains at all.
- Runtime execution profile resolution should not hardcode tool bundles.
- Any config key named `tool_allowlist` should be audited:
  - keep it only as the current turn's effective allowlist
  - do not use it as persisted source of truth

### Observability

Files:

- `apps/orchestrator/lib/symphony_elixir/runner/observability.ex`
- `apps/orchestrator/test/symphony_elixir/runner/observability_test.exs`
- `docs/end-to-end-logging-improvement-pr-plan.md`

Needed changes:

- Tool denial logs should identify whether the denied tool was missing from
  effective grants, disabled, or unknown to the registry.
- Logs should include `agent_id`, `workspace_id`, `tool_name`, and a redacted
  grant/provenance summary when available.

## Runtime PR Sequence

### RUNTIME-1 - Documentation And Contract Cleanup

- Replace legacy bundle/override language in runtime docs.
- Document `agent_tool_grant` as the effective source of truth.

### RUNTIME-2 - Grant-Derived Tool Set Contract

- Update dispatch/runner contract docs and tests so tool definitions are treated
  as effective grants, not role defaults.
- Add tests showing a tool removed from grants is absent from the next model
  request.

### RUNTIME-3 - Optional Direct DB Resolver

Only needed if Runtime reads Harper directly for tool policy.

- Implement `ToolRegistry.resolve_for_agent/1` against `agent_tool_grant`.
- Join `tool` by `tool_id`, filter `grant.mode = 'include'` and
  `tool.enabled = true`.
- Do not read `tool_policy_template` at runtime.

### RUNTIME-4 - Runner And Relay Smoke Coverage

- Planner, manager, and local-model coding smokes should verify tool changes
  take effect on the next turn/start.
- Mixed helper/runtime-managed tool sets should still route by tool execution
  metadata.

## Verification

- `mix test`
- focused tests:
  - `test/symphony_elixir/tool_registry_test.exs`
  - `test/symphony_elixir/runner/planner_test.exs`
  - `test/symphony_elixir/runner/manager_test.exs`
  - `test/symphony_elixir/runner/local_relay_tool_test.exs`
- local relay smoke with one manually removed grant and one manually added
  grant
