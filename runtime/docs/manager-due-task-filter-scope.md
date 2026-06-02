# Manager Due-Task Query Filter — Runtime Scoping Document

## Goal

Make the manager scheduler's "due work items" query configurable per
agent (with a workspace-level fallback) along two dimensions:

- **`states`** — which work-item states qualify as "due" (currently
  hardcoded to `["running", "awaiting_review"]`).
- **`plan_ids`** — restrict the manager to work items belonging to a
  specific list of plans (currently no restriction).

Two other knobs (`batch_limit`, `order_by`) stay hardcoded at their
current defaults (`25`, `next_poll_at ASC`) — explicitly out of scope
for this PR.

## Prerequisites

- **Runtime PR-A** (`feat/manager-per-agent-scheduler`, branch in this
  repo) must be merged first. PR-A introduces per-agent scheduler
  topology and per-agent gateway-config keys
  (`runners.manager.<agent_id>.*`). This PR builds on that surface.
- This PR is *runtime-only*. The platform UI for these filters is
  scoped separately in `parallel-agent-platform` (see
  `docs/manager-agent-settings-scope.md` in that repo).

## Storage

Per-agent and per-workspace gateway config keys:

```jsonc
// gateway_config.config_json
{
  "runners": {
    "manager": {
      // Workspace-level defaults (existing today for cadence; this PR
      // adds the same shape for due_task_query)
      "min_cadence_ms": 60000,
      "due_task_query": {
        "states": ["running", "awaiting_review"],
        "plan_ids": null
      },

      // Per-agent override (new in PR-A, extended here)
      "<agent_id>": {
        "min_cadence_ms": 30000,
        "due_task_query": {
          "states": ["running"],
          "plan_ids": ["uuid-1", "uuid-2"]
        }
      }
    }
  }
}
```

Resolution: per-agent value if present, otherwise workspace value,
otherwise built-in default. `plan_ids: null` (or missing key) means
"no plan filter."

## Files to touch

| File | Change |
|---|---|
| `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex` | Read `due_task_query` config; pass `states` + `plan_ids` into `due_query`. |
| `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex` (`due_query/3`) | Extend signature to accept `states` and optional `plan_ids`; build query dynamically. |
| `apps/orchestrator/test/symphony_elixir/manager/scheduler_test.exs` | New test cases for filter resolution and query shape. |

PR-A added `configured_min_cadence_ms/2` (per-agent + workspace
fallback). Add a sibling `configured_due_task_query/2` with the same
fallback shape.

## Specific changes

### 1. New module attribute and config reader

In `manager/scheduler.ex`:

```elixir
@default_due_task_query %{
  states: ["running", "awaiting_review"],
  plan_ids: nil
}

@allowed_states ~w(pending running awaiting_review blocked done failed)
# (Pull the actual allowed values from the work_items state enum;
# see apps/orchestrator/priv/generated/postgrest-schema.json or the
# work_item_row.ex file for the authoritative list.)

defp configured_due_task_query(workspace_id, agent_id) do
  case GatewayConfig.fetch("workspace", workspace_id) do
    {:ok, %{config_json: config}} ->
      agent_value = get_in(config, ["runners", "manager", agent_id, "due_task_query"])
      workspace_value = get_in(config, ["runners", "manager", "due_task_query"])
      merge_due_task_query(agent_value, workspace_value)

    _ ->
      @default_due_task_query
  end
end

defp merge_due_task_query(nil, nil), do: @default_due_task_query
defp merge_due_task_query(nil, workspace), do: normalize_due_task_query(workspace)
defp merge_due_task_query(agent, _), do: normalize_due_task_query(agent)

defp normalize_due_task_query(value) when is_map(value) do
  states =
    case Map.get(value, "states") || Map.get(value, :states) do
      list when is_list(list) ->
        list
        |> Enum.map(&to_string/1)
        |> Enum.filter(&(&1 in @allowed_states))
        |> case do
          [] -> @default_due_task_query.states
          valid -> valid
        end

      _ -> @default_due_task_query.states
    end

  plan_ids =
    case Map.get(value, "plan_ids") || Map.get(value, :plan_ids) do
      nil -> nil
      list when is_list(list) ->
        ids = Enum.filter(list, &valid_uuid?/1)
        if ids == [], do: nil, else: ids
      _ -> nil
    end

  %{states: states, plan_ids: plan_ids}
end

defp normalize_due_task_query(_), do: @default_due_task_query
```

Invalid config (e.g. unknown state, malformed UUID list) silently
falls back rather than crashing. Log a warning when fallback occurs so
operators can debug.

### 2. Extend `due_query`

```elixir
def due_query(workspace_id, agent_id, now, opts \\ []) do
  states = Keyword.get(opts, :states, @default_due_task_query.states)
  plan_ids = Keyword.get(opts, :plan_ids)
  limit = Keyword.get(opts, :limit, @default_batch_limit)

  query =
    from(wi in WorkItemRow,
      where: wi.workspace_id == ^workspace_id,
      where: wi.manager_runner_id == ^agent_id,  # added by PR-A
      where: wi.state in ^states,
      where: not is_nil(wi.next_poll_at),
      where: wi.next_poll_at <= ^now,
      order_by: [asc: wi.next_poll_at],
      limit: ^limit
    )

  case plan_ids do
    nil -> query
    [] -> query
    ids -> from(wi in query, where: wi.plan_id in ^ids)
  end
end
```

### 3. Wire into the tick path

In `run_tick/1` or `poll_due_work_items/3`, replace:

```elixir
state.workspace_id
|> due_query(now, limit: state.batch_limit)
|> state.repo.all()
```

with:

```elixir
%{states: states, plan_ids: plan_ids} =
  configured_due_task_query(state.workspace_id, state.agent_id)

state.workspace_id
|> due_query(state.agent_id, now,
     states: states,
     plan_ids: plan_ids,
     limit: state.batch_limit
   )
|> state.repo.all()
```

The scheduler should re-read the config on each tick (not cache it) so
that UI changes take effect on the next cycle without a scheduler
restart. Reading gateway config is cheap (single Supabase row); if
profiling shows otherwise, add a short-TTL cache.

## Acceptance criteria

- [ ] Scheduler reads `runners.manager.<agent_id>.due_task_query` per
  tick; falls back to workspace, then default.
- [ ] `states` filter restricts the result set to the configured
  states only.
- [ ] `plan_ids` filter (when non-empty) restricts to work items in
  the given plans; `null` or empty list means no plan filter.
- [ ] Invalid states (not in the work_items state enum) are dropped;
  if all are invalid, default states apply. Logs a warning.
- [ ] Invalid `plan_ids` (non-UUID values) are dropped; if all are
  invalid, no filter applies. Logs a warning.
- [ ] `batch_limit` and `order_by` remain hardcoded at current values.
- [ ] No change to behavior when no config is set — defaults match
  previous hardcoded query exactly.

## Test plan

Add to `manager/scheduler_test.exs`:

- [ ] Default config: returns work items in both `running` and
  `awaiting_review` states.
- [ ] Workspace-level `states: ["running"]`: excludes
  `awaiting_review`.
- [ ] Per-agent `states: ["running"]` with workspace
  `["running","awaiting_review"]`: per-agent wins.
- [ ] Per-agent `plan_ids: [<plan_a>]`: excludes work items from
  `<plan_b>`.
- [ ] `plan_ids: null` and missing key behave identically (no filter).
- [ ] `plan_ids: []` (empty list) behaves as no filter.
- [ ] Invalid state in config (e.g. `["nonsense"]`) falls back to
  defaults and logs.
- [ ] Invalid plan_id (e.g. `["not-a-uuid"]`) is dropped; if any valid
  ids remain, those are applied; otherwise no filter.
- [ ] Config change between ticks is observed on the next tick (no
  caching).

## Out of scope

- Batch limit configurability.
- Order-by configurability.
- Label / priority / tag filters.
- Schema changes (no migration in `harper-server`).

## Validation

```bash
cd apps/orchestrator
mix compile --warnings-as-errors
mix test
```

Per CLAUDE.md, both must pass before push.

## Related work

- Runtime PR-A: `feat/manager-per-agent-scheduler` — must merge first.
- Platform PR (separate repo): see
  `parallel-agent-platform/docs/manager-agent-settings-scope.md` for
  the UI that produces this config.
