# Workspace Concurrency Caps - Runtime Scope

Companion platform scope:
`parallel-agent-platform/docs/active/workspace-concurrency-caps-scope.md`.

Companion schema scope:
`harper-server/docs/workspace-concurrency-caps-schema-scope.md`.

## Goal

Make the runtime enforce the workspace-level
`workspace_settings.max_concurrent_agents` cap while preserving the
existing workflow, per-state, and worker-host concurrency limits.

The runtime must keep over-cap work queued. It should not reject the
plan, fail work items, or spawn more agents than the workspace allows.

## Current State

Already implemented:

- `agent.max_concurrent_agents` exists in `WORKFLOW.md`.
- `agent.max_concurrent_agents_by_state` exists for state-level caps.
- `DispatchPolicy.available_slots/1` checks the current orchestrator
  process' `running` map.
- `DispatchPolicy.state_slots_available?/2` applies per-state limits.
- `WorkerHostSelector` can enforce per-host SSH worker capacity.
- `WorkspaceSettings.Repository` already reads `workspace_settings`
  fields for learning and tracker settings.

Missing:

- `WorkspaceSettings.Repository` does not read
  `max_concurrent_agents`.
- `Config` has no workspace-cap resolver.
- `DispatchPolicy` does not include workspace policy in
  `available_slots/1`.
- Capacity-blocked dispatches have no structured reason.
- Tests only cover workflow/process caps, not a workspace-owned cap.

## PR 3 - Runtime Dispatch Enforcement

This is PR 3 in the cross-repo plan from the platform scope.

### Work

- Extend `WorkspaceSettings.Repository`:
  - include `max_concurrent_agents` in settings selects;
  - return default `10` when no row exists;
  - reject malformed values before callers use them;
  - reject values below `1` or above the hard maximum `50`.
- Add a workspace cap resolver:
  - input: `workspace_id`;
  - output: `{:ok, positive_integer}` or structured error;
  - cache only if needed, with a short TTL and invalidation path for
    existing workspace-settings tools.
- Extend orchestrator state or dispatch evaluation to carry the
  effective workspace cap for the current poll cycle.
- Compute effective global slots as the most restrictive limit:
  - workflow `agent.max_concurrent_agents`;
  - `workspace_settings.max_concurrent_agents`;
  - current in-memory running/claimed count;
  - existing per-state cap;
  - existing worker-host cap.
- Add a structured skip reason/log metadata value:
  `workspace_capacity_full`.
- Leave over-cap items in their existing queued/active-eligible state.
- Do not terminate active runs if the cap is lowered below current
  active count. New dispatch resumes once active count falls below cap.

### Cross-Orchestrator Note

The current runtime cap is process-local. The implementation should
avoid making this worse, but v1 can ship as a workspace policy enforced
by each orchestrator process if the launcher guarantees one active
dispatch loop per workspace. If multiple dispatch loops can poll the
same workspace concurrently, this PR must add a shared capacity check
before spawn, such as:

- counting active `work_items` states for the workspace via PostgREST;
- atomically claiming a work item only when the active count is below
  cap; or
- routing all workspace dispatch through a single scheduler process.

The PR should document which invariant is true in code. If the invariant
is not already true, implement the shared check rather than relying only
on `state.running`.

### Likely Files

- `apps/orchestrator/lib/symphony_elixir/workspace_settings/repository.ex`
- `apps/orchestrator/lib/symphony_elixir/config.ex`
- `apps/orchestrator/lib/symphony_elixir/orchestrator.ex`
- `apps/orchestrator/lib/symphony_elixir/orchestrator/dispatch_policy.ex`
- `apps/orchestrator/lib/symphony_elixir/orchestrator/snapshot_builder.ex`
- `apps/orchestrator/lib/symphony_elixir/status_dashboard/snapshot_formatter.ex`
- `apps/orchestrator/test/symphony_elixir/workspace_settings/repository_test.exs`
- `apps/orchestrator/test/symphony_elixir/orchestrator/*`
- `apps/orchestrator/test/symphony_elixir/workspace_and_config_test.exs`

### Tests

- Missing `workspace_settings` row returns default cap `10`.
- Invalid `max_concurrent_agents` response returns structured error,
  including values above `50`.
- Effective cap uses the minimum of workflow cap and workspace cap.
- With workspace cap `2` and five runnable items, one poll cycle spawns
  at most two.
- When two are active, the third item is skipped with
  `workspace_capacity_full` and stays queued.
- After one running item completes or is reconciled terminal, a later
  poll can dispatch the next item.
- Lowering cap below active count does not terminate existing active
  tasks.

## Non-Goals

- No platform settings UI in this repo.
- No Harper migration in this repo.
- No per-runner or per-execution-target caps.
- No local-helper capacity negotiation.
- No replacement of existing per-state or worker-host caps.

## Definition of Done

- Runtime reads and validates `workspace_settings.max_concurrent_agents`.
- Runtime treats `50` as the hard maximum even if a malformed upstream
  row somehow bypasses Platform validation.
- Dispatch never exceeds the effective workspace cap in the supported
  launcher topology.
- Over-cap work remains queued and observable.
- Tests cover default, full-cap, and release-on-terminal behavior.
