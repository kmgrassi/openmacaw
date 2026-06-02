# Policy & Trust Dial — Runtime Scope

Companion to the platform scope at
[`docs/active/policy-trust-dial-scope.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/policy-trust-dial-scope.md)
in `parallel-agent-platform`. That doc owns the policy schema
(`contracts/escalation-policy.ts`), the `escalation` table, the
platform API + UI, and the policy lifecycle. This doc owns the
**runtime enforcement** — the four enforcement points that read the
policy, detect violations, and write escalation rows.

Read the platform scope first. This doc assumes its vocabulary
(`EscalationPolicy`, `escalation` table shape, the four trigger
kinds: structural, self_flagged, resource, gate_failure).

## Goal

The orchestrator must enforce the workspace's trust dial on behalf
of every agent it runs. When a structural rule matches a planned
change, when a resource cap is reached, when a gate-failure
threshold is breached, or when an agent itself decides to surface,
the orchestrator must:

1. **Stop the agent from completing the irreversible action** (the
   merge, the deploy, the next turn — whichever the policy
   forbids).
2. **Write an `escalation` row** with the correct trigger kind and
   trigger detail.
3. **Pause the work item** in a state the human-resolution flow
   (Pillar 4.5) can pick up.
4. **Resume the agent automatically** when the escalation resolves
   (Pillar 4.5 owns re-entry; this scope just emits a clean pause
   signal).

Specifically:

1. **A `PolicyCache`** that reads the workspace policy via the
   platform REST surface, parses it through the schema mirror, and
   caches per-workspace with a version-aware invalidation hook.
2. **Four enforcers**, one per trigger kind, each integrated into
   the appropriate orchestrator hook.
3. **The `escalate_to_human` tool dispatcher** that handles the
   `self_flagged` case from the agent's side.
4. **A `Attention.escalate/3` implementation** replacing the
   placeholder noted in
   [`intelligent-cutovers-runtime-scope.md`](./intelligent-cutovers-runtime-scope.md).
   Cutover-exhausted walks now write real escalation rows.

## Current state

### What the orchestrator already does

- **Turn loop** in
  `apps/orchestrator/lib/symphony_elixir/runner/llm_tool_runner.ex`
  drives the agent's turns. The orchestrator already counts turns
  but does not bound them workspace-policy-wise.
- **Tool dispatch** in the same module routes tool calls to
  registered handlers. `escalation.escalate_to_human` plugs in here.
- **Best-effort persistence pattern**
  ([`best-effort-persistence-logging.md`](./best-effort-persistence-logging.md))
  for posting rows to the platform PostgREST surface. Escalation
  writes use this pattern (logged failures, but don't fail the
  agent if the API is briefly unreachable — escalation surface
  re-tries).
- **`Cutover.walk/3`** (from the intelligent-cutovers scope) calls
  `Attention.escalate(:cutover_exhausted, decision, session)` on
  walk failure. Today that's a placeholder logging a `RuntimeLog`
  event of kind `attention_required`. After this scope, it becomes
  a real write to the `escalation` table.

### What doesn't exist yet

- **No `PolicyCache` module.** No code reads policy from
  `gateway_config`.
- **No path-glob matcher.** No `MatchSpec` or `Path.wildcard` usage
  for runtime structural checks.
- **No dependency-change / schema-migration / secret-rotation
  detectors.** Nothing inspects a planned diff.
- **No resource cap enforcers.** `max_turns` exists in env config
  but isn't workspace-policy-driven; `max_wallclock_minutes`,
  `max_cost_usd`, `max_retries` are unbuilt.
- **No `gate_failure_count`** on work-item runtime state. Pillar
  4.3 will own gate evaluation; this scope owns the
  failure-threshold counter that escalates when 4.3 reports a
  failure and auto-recovery is exhausted.
- **No `escalate_to_human` tool implementation.**
- **No `Attention` module.** `Cutover.walk/3` calls a function that
  doesn't exist yet (intentional placeholder per OQ-CR-1 in the
  cutover runtime scope).

## Proposed model

### `PolicyCache`

New module
`apps/orchestrator/lib/symphony_elixir/policy/policy_cache.ex`:

```elixir
defmodule SymphonyElixir.Policy.PolicyCache do
  use GenServer
  alias SymphonyElixir.Policy.EscalationPolicy

  @spec get(workspace_id :: String.t()) :: EscalationPolicy.t()
  def get(workspace_id), do: GenServer.call(__MODULE__, {:get, workspace_id})

  @spec invalidate(workspace_id :: String.t()) :: :ok
  def invalidate(workspace_id), do: GenServer.cast(__MODULE__, {:invalidate, workspace_id})

  # Internal: refetches from /api/workspaces/:id/policy via PlatformClient,
  # parses through EscalationPolicy schema, caches in ETS keyed by workspace_id.
  # Re-fetches every 60s as a stale-tolerance fallback. Platform may push
  # invalidation via the relay (future enhancement).
end
```

- ETS-backed for O(1) reads.
- Default 60s TTL — the policy is loose enough that 60s of staleness
  is acceptable, given enforcers are best-effort already.
- Future enhancement: platform pushes invalidation events through
  the existing runtime → platform event channel. Out of scope for
  v1.

### Path-glob matcher

`apps/orchestrator/lib/symphony_elixir/policy/path_glob.ex`:

```elixir
@spec matches?(pattern :: String.t(), path :: String.t()) :: boolean()
def matches?(pattern, path)
```

Implementation uses
`PathGlob.match?/3` (Elixir's `Path.wildcard` + `:fnmatch` is
insufficient — needs `**` recursive support). Use the existing
`path_glob` hex package or vendor a minimal implementation
matching gitignore-style `**` semantics.

Test matrix in `test/symphony_elixir/policy/path_glob_test.exs`:
- `infra/**` matches `infra/cors.tf`, `infra/dev/aws/main.tf`;
  does NOT match `apps/api/src/infra/route.ts`.
- `**/migrations/**` matches at any depth.
- Single-component globs match exactly one component (`*.tf`).
- Negation patterns (`!` prefix) — defer to v2 if any user asks.

### Four enforcers

Each enforcer is a small module under
`apps/orchestrator/lib/symphony_elixir/policy/`:

#### `StructuralEnforcer`

```elixir
@spec check_diff(workspace_id, diff :: %{paths: [String.t()], dep_files: [String.t()],
                                          migration_files: [String.t()],
                                          secret_files: [String.t()]}) ::
  :ok | {:escalate, %EscalationTrigger{}}
```

Called by:
- The merge tool (Pillar 4.3) before performing the merge.
- The commit tool (when an agent calls "commit these changes" as
  its irreversible step).

Behavior:
1. Fetch policy via `PolicyCache.get(workspace_id)`.
2. For each `structural.require_human_for` entry:
   - `path_glob`: check `diff.paths` against the pattern.
   - `dependency_change`: check `diff.paths` against a hardcoded
     dependency-file list — `package.json`, `pnpm-lock.yaml`,
     `Cargo.toml`, `requirements.txt`, `pyproject.toml`, `go.mod`,
     `go.sum`, `mix.exs`, `Gemfile`, etc. Configurable via
     `config :symphony_elixir, :dependency_files, [...]`.
   - `schema_migration`: check for paths under `supabase/migrations/`,
     `db/migrate/`, `migrations/`, `alembic/versions/`. Same
     configurable approach.
   - `secret_rotation`: check for paths matching `.env`, `*.pem`,
     `**/secrets.yaml`, etc.
3. On match, return `{:escalate, %EscalationTrigger{kind:
   "structural", detail: {kind: "path_glob", pattern: "..."} }}`.
   First match wins (multiple rules matching = first one fires).

#### `ResourceEnforcer`

Three checkpoints, all called at turn boundaries:

```elixir
@spec check_turns(work_item_id, policy :: EscalationPolicy.t()) :: :ok | {:escalate, ...}
@spec check_wallclock(work_item_id, started_at, policy) :: :ok | {:escalate, ...}
@spec check_retries(work_item_id, policy) :: :ok | {:escalate, ...}
@spec check_cost(workspace_id, work_item_id, policy) :: :ok | {:escalate, ...}
```

- `check_turns`: read turn count from work-item runtime state;
  compare to `resource.max_turns_per_task`. Exceeded → escalate.
- `check_wallclock`: `now() - started_at > max_wallclock_minutes`
  → escalate.
- `check_retries`: read retry count from broker_task; exceeded
  `resource.max_retries` → escalate.
- `check_cost`: HTTP GET to
  `/api/workspaces/:workspaceId/learning-cost?workItemId=:id`
  (new endpoint, see platform scope's repository section);
  compare `total_cost_usd` against the *tighter* of
  `policy.resource.max_cost_usd` and the per-task override.
  Exceeded → escalate.

All four called by the orchestrator's turn-loop driver before each
turn begins. If any fires, the work item pauses immediately; the
current in-flight turn is allowed to complete cleanly (the
enforcer's job is to stop the *next* turn, not abort mid-stream).

#### `GateFailureEnforcer`

Lightweight — just a counter check:

```elixir
@spec on_gate_failure(work_item_id, gate_name, policy) :: :recover | {:escalate, ...}
```

- Increment `gate_failure_count` for the work item.
- If count > `policy.gate_failure.after_auto_recovery_attempts`,
  return escalate.
- Otherwise return recover (the agent is allowed to try fixing
  the failure).

Wired into Pillar 4.3's gate-evaluation path; until 4.3 ships, the
enforcer module exists but no caller invokes it.

#### `SelfFlaggedEnforcer`

Dispatches the `escalate_to_human` tool call:

```elixir
@spec handle_tool_call(args :: map(), session) :: {:ok, response} | {:error, reason}
def handle_tool_call(args, session) do
  # 1. Validate args (Zod schema mirror).
  # 2. Check policy.self_flagged.tool_enabled — if false, return error.
  # 3. POST /api/escalations with trigger_kind="self_flagged".
  # 4. Pause work item.
  # 5. Return {:ok, escalation_id + "Paused for human review"}.
end
```

The tool registration goes in
`apps/orchestrator/lib/symphony_elixir/tools/escalation_tools.ex`,
following the existing tool registry pattern.

### Pause semantics

Across all four enforcers, "pause the work item" means the same
thing:

1. Transition work item's runtime state to `:paused_for_human` (a
   new value in the existing work-item state machine; add to the
   relevant enum / check constraint via harper-server migration in
   platform Phase 2).
2. Stop the orchestrator's per-work-item driver.
3. Record the escalation id on the work-item row's metadata for
   resolution flow lookup.
4. The dispatch loop skips work items in `:paused_for_human` state
   on subsequent polls — they sit idle until Pillar 4.5's
   resolution path transitions them back to `:queued` or
   `:in_progress`.

### `Attention.escalate/3` real implementation

`apps/orchestrator/lib/symphony_elixir/policy/attention.ex`:

```elixir
@spec escalate(reason :: atom(), context :: map(), session) :: :ok
def escalate(reason, context, session) do
  case reason do
    :cutover_exhausted ->
      write_escalation(session.workspace_id, %{
        trigger_kind: "resource",
        trigger_detail: %{resource: "model_availability", context: context},
        reason: "All fallback models exhausted: #{context.from_model}",
        ...
      })

    :cutover_floor_exhausted ->
      write_escalation(session.workspace_id, %{
        trigger_kind: "resource",
        trigger_detail: %{resource: "model_tier_floor", context: context},
        reason: "No fallback met the adequacy floor: #{context.floor}",
        ...
      })

    :resource_exceeded ->
      # Called by ResourceEnforcer
      ...

    :structural_rule_matched ->
      # Called by StructuralEnforcer
      ...

    :self_flagged ->
      # Called by SelfFlaggedEnforcer
      ...
  end

  pause_work_item(session.work_item_id)
end
```

Single entry point so all enforcers — and the cutover engine —
funnel through one place that knows how to write the row, pause
the work item, and trigger delivery channels.

## Phased migration

Tracks platform phases:

### R-1 — `PolicyCache` + schema mirror

Tracks platform Phase 1.

- New module
  `apps/orchestrator/lib/symphony_elixir/policy/escalation_policy.ex`,
  generated from `contracts/escalation-policy.ts` by the
  schema-sync script.
- New `PolicyCache` GenServer + ETS table.
- Supervisor wiring in `application.ex`.
- Tests: cache hit/miss, TTL behavior, malformed-policy
  resilience.

### R-2 — `Attention` module + escalation writes

Tracks platform Phase 2.

- New `apps/orchestrator/lib/symphony_elixir/policy/attention.ex`.
- `Attention.escalate/3` implemented with all reason atoms.
- HTTP client to POST `/api/escalations` using
  best-effort persistence.
- Wired into `Cutover.walk/3` to replace the placeholder.
- Add `escalation` to `BRIDGE_TABLES` in
  `scripts/append-supabase-jsdoc-types.mjs`.

### R-3 — Path-glob matcher + `StructuralEnforcer`

Tracks platform Phase 3.

- `apps/orchestrator/lib/symphony_elixir/policy/path_glob.ex`.
- `apps/orchestrator/lib/symphony_elixir/policy/structural_enforcer.ex`.
- Hardcoded but configurable lists for dependency files, migration
  paths, secret-file patterns.
- Test matrix in `path_glob_test.exs`.
- No call sites yet (the merge tool / commit tool that invoke
  `StructuralEnforcer.check_diff/2` arrive with Pillar 4.3).

### R-4 — `ResourceEnforcer` at turn boundaries

Tracks platform Phase 4.

- Four checks integrated into the turn-loop driver in
  `llm_tool_runner.ex`.
- Cost-check HTTP call cached for 30s (cost aggregation lags
  reality; precision tighter than 30s isn't useful).
- Per-task override read from `task.policy_overrides` (added in
  platform Phase 7; until then, override always null).

### R-5 — `escalate_to_human` tool dispatch

Tracks platform Phase 5.

- `apps/orchestrator/lib/symphony_elixir/tools/escalation_tools.ex`.
- Tool registered in the runtime tool registry.
- Default tool grants (platform-side) inject this tool for every
  agent.
- Tests: argument validation, policy gating (tool_enabled=false →
  error), escalation row write + work-item pause.

### R-6 — `GateFailureEnforcer`

Tracks platform Phase 6.

- Counter in work-item runtime state.
- Module + tests.
- No active caller yet; Pillar 4.3 will invoke it.

### R-7 — Cleanup: remove cutover placeholder log

Cutover engine's
`Observability.log_event(:attention_required, ...)` placeholder
gets removed once `Attention.escalate/3` is the canonical path.

## Open questions

### OQ-PR-1 — Where exactly does `StructuralEnforcer.check_diff/2` get called from in v1?

Pillar 4.3 (auto-merge) is the natural caller, but 4.3 doesn't
exist yet. Do we wire the enforcer with no callers and wait, or
plumb it into the current "agent calls commit tool" path
opportunistically?

**Tentative answer**: wire the module with no callers in R-3.
When 4.3's auto-merge tool lands, that's its first caller. In the
interim, the structural enforcer is dead code but tested. This
keeps the policy → enforcement contract whole even if the
consumer side isn't built yet.

### OQ-PR-2 — Diff extraction for structural rules

`StructuralEnforcer.check_diff/2` takes a `%{paths, dep_files,
migration_files, secret_files}` payload. How does the caller
construct that?

**Tentative answer**: the caller (the merge or commit tool) does
the diff extraction. The most natural source is the `git diff
--name-only` against the base branch — but Codex runners go
through a slightly different commit ceremony. For v1, each tool
implementation is responsible for producing the file list; the
enforcer doesn't reach into git itself. Documented in the
enforcer's docstring.

### OQ-PR-3 — Cost cap precision

`learning_cost` aggregates after broker_task completion. A turn
that costs $4 against a $5 cap will not register until the turn
finishes, so the next-turn check sees $4. If the next turn is
about to cost $3, the enforcer doesn't predict it. The cap is
effectively *exceeded* by one turn.

**Tentative answer**: accept the imprecision. The cap is a budget,
not a kill-switch. Document it as "you may overrun by one turn"
in user-facing docs. Pre-call cost prediction is OQ-PD-2 in the
platform scope; out of scope here.

### OQ-PR-4 — Work-item pause state semantics

The new `:paused_for_human` state needs to compose cleanly with
the existing runtime state machine (queued, in_progress, blocked,
etc.). What transitions are legal?

**Tentative answer**: only Pillar 4.5's resolution path can
transition out of `:paused_for_human` (to `:queued` if the human
said "redo with X," to `:cancelled` if they cancelled). The
orchestrator never auto-resumes from this state. Documented in
the work-item state machine reference.

### OQ-PR-5 — Multiple simultaneous escalations on one work item

What if a single turn triggers both a structural rule (touched
infra/) and a resource cap (max_turns)? Two escalation rows or
one?

**Tentative answer**: one row per *trigger*. The first to fire
wins; the work item pauses; subsequent checks during the in-flight
turn complete are recorded as additional escalation rows
referencing the same work_item_id. The dashboard view (Pillar
4.5) can deduplicate by work_item_id for the queue display.

## Out of scope

- **Re-entry / resume after escalation resolves** — Pillar 4.5.
- **Dashboard surface for escalations** — Pillar 4.5.
- **Email / Slack delivery channels** — platform scope's deferred
  phases.
- **Per-agent (vs per-workspace) policy** — platform OQ-PD-1.
- **Pre-call cost prediction** — see OQ-PR-3.
- **Configurable dependency/migration/secret file lists per
  workspace.** v1 uses hardcoded defaults configurable in
  `config :symphony_elixir`; per-workspace customization is a
  follow-on.
- **`StructuralEnforcer` consumer wiring (merge tool, commit
  tool).** The enforcer ships in R-3; its consumers ship with
  Pillar 4.3.

## Success criteria

1. `PolicyCache.get(workspace_id)` returns a parsed
   `EscalationPolicy` struct for every active workspace, refreshed
   at most every 60 seconds.
2. `Attention.escalate(:cutover_exhausted, decision, session)`
   writes a real `escalation` row (cutover's placeholder log is
   gone).
3. A workspace with `structural.require_human_for: [{kind:
   "path_glob", pattern: "infra/**"}]` causes
   `StructuralEnforcer.check_diff/2` to return `{:escalate, ...}`
   when called with a diff containing `infra/cors.tf`.
4. A workspace with `resource.max_turns_per_task: 10` causes the
   orchestrator's turn-loop driver to escalate the work item at
   turn 11 with `trigger_kind: "resource"`, `trigger_detail:
   {resource: "turns", value: 11, limit: 10}`.
5. An agent calling `escalation.escalate_to_human(reason: "...",
   context: "...")` produces an escalation row with
   `trigger_kind: "self_flagged"`, pauses the work item, and
   returns the escalation id to the agent.
6. A work item in `:paused_for_human` state is not picked up by
   the dispatch loop until something external transitions it out.
7. The path-glob matcher passes the full test matrix in
   `path_glob_test.exs`, including `**` recursion, single-segment
   wildcards, and case sensitivity matching the host filesystem.

When these are true alongside the platform success criteria,
Pillar 4.6 closes.
