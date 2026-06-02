# Session Current Plan ID Scope

## Premise

Today the planner agent has to pass `plan_id` on every `task.create`
call, even when it just created or read a plan moments ago in the
same chat. The system already knows which plan is "current" — the
last one the agent explicitly touched — but doesn't track it in the
session. This scope adds that tracking with strict, visible rules so
the agent doesn't have to repeat the id, but also can't accidentally
target the wrong plan.

## Current State

- `apps/orchestrator/lib/symphony_elixir/planner/tools/context.ex`
  surfaces `workspace_id`, `agent_id`, etc. — no `current_plan_id`.
- `planner_tool_executor.ex` injects session context but has no
  notion of "the plan we're working on".
- `task.create` requires `plan_id` explicitly (the helpful default in
  PR #377 is only the *repository*, not the plan).

## Target State

- A `current_plan_id` field on the planner session, set on:
  - `plan.create` (after a successful create, this becomes current);
  - `plan.read` (the read plan becomes current);
  - explicit clear via a new `plan.select` tool (or omitted —
    see Open Questions).
- `task.create` and `task.schedule` accept `plan_id` as optional. When
  omitted, the runtime fills in `current_plan_id`.
- The tool result envelope always echoes the resolved
  `plan_id` and the source (`"explicit" | "session"`) so the agent
  sees what was filled in and can override on the next call if it's
  wrong.
- The session's `current_plan_id` resets when:
  - `plan.delete` removes the current plan;
  - the planner explicitly creates/reads a different plan
    (overwrite);
  - the gateway session ends or rotates.

## Why The Audit Called This Risky

The Explore audit (transcript reference) flagged that if a planner
creates Plan A, then Plan B, then calls `task.create` without
`plan_id`, "current" is ambiguous. This scope addresses that by:

- defining "current" precisely as **the most recent plan the agent
  touched** (created or read);
- echoing the resolved `plan_id` and source in every tool result, so
  the agent has a chance to see and correct;
- requiring an explicit override on `task.create` when the agent
  intends a different plan;
- never inferring `plan_id` from anything except explicit prior plan
  ops — not from task lookup, not from work-item context.

The "create Plan A, create Plan B, task.create" sequence resolves to
Plan B, which is the lexically nearest preceding plan. That matches
what the agent's last action expressed. If the agent wanted Plan A,
it must pass `plan_id = A` explicitly.

## Phased Work

### CURRENT-1 — Add `current_plan_id` To Session State

- Extend `Gateway.SessionStore` (or wherever planner session state
  lives) with a nullable `current_plan_id`.
- Plumb it through `Planner.Tools.Context` so tools can read it.
- No tool uses it yet; just the plumbing.

**Independent**: no behaviour change.

### CURRENT-2 — Update `plan.create` / `plan.read` To Set `current_plan_id`

- After a successful `plan.create` (or `plan.read` with a valid
  plan_id), set the session's `current_plan_id`.
- After `plan.delete` of the current plan, clear it.
- Test that subsequent reads of session state see the new value.

**Gates on**: CURRENT-1.

### CURRENT-3 — Default `plan_id` On `task.create` / `task.schedule`

- Make `plan_id` optional in the JSON schemas of `task.create` and
  `task.schedule`.
- When omitted, fall back to `current_plan_id`.
- Tool result includes `plan_id` and `plan_id_source: "explicit" |
  "session"`.
- When neither source resolves, return
  `{:error, {:missing_plan_id, "no plan_id in args and no current
  plan in session — call plan.create or plan.read first"}}`.

**Gates on**: CURRENT-2.

### CURRENT-4 — Add `plan.select` (Optional)

- A tool that explicitly sets the current plan without reading or
  modifying it. Useful when the agent wants to switch to an existing
  plan without doing a full `plan.read`.
- Lower priority — `plan.read` already covers the use case at the
  cost of one extra DB read.

## Test Cases

### Unit: `plan.create` sets `current_plan_id`

```
given:  empty session
when:   plan.create with name = "P1" succeeds
then:   session.current_plan_id = P1.id
```

### Unit: `task.create` inherits from session

```
given:  session.current_plan_id = P1
when:   task.create with name = "T" and no plan_id
then:   work_items row has plan_id = P1
and:    tool result includes plan_id_source = "session"
```

### Unit: explicit `plan_id` wins without updating session

```
given:  session.current_plan_id = P1
when:   task.create with plan_id = P2, name = "T"
then:   work_items row has plan_id = P2
and:    tool result includes plan_id_source = "explicit"
and:    session.current_plan_id is unchanged (still P1) — explicit
        override does not silently switch the session pointer
```

### Unit: most-recent plan wins ambiguity

```
given:  agent calls plan.create P1, then plan.create P2,
        then task.create without plan_id
then:   the resulting task has plan_id = P2 (most recent)
and:    tool result echoes plan_id = P2 with source "session"
```

### Negative: no current plan, no explicit plan_id

```
given:  fresh session, no plans created or read
when:   task.create with name = "T" and no plan_id
then:   {:error, {:missing_plan_id, ...}} returned to the agent
```

### Negative: deleted current plan

```
given:  session.current_plan_id = P1
when:   plan.delete with plan_id = P1 succeeds
then:   session.current_plan_id is cleared
and:    a subsequent task.create with no plan_id returns
        :missing_plan_id
```

### Browser smoke

1. Prompt: "Create a plan named Current Plan Smoke."
2. Prompt: "Add a task called Verify inheritance."
3. Confirm the planner calls `task.create` without `plan_id` and
   succeeds.
4. Confirm the work_items row has the correct `plan_id`.
5. Confirm the assistant message references both the plan id and
   shows `plan_id_source: "session"` in the tool result it received.

## Non-Goals

- Tracking current task_id similarly — `task.update` and `task.read`
  need explicit task_id; auto-inferring it from "last touched task"
  is much more error-prone.
- Sharing `current_plan_id` across agent sessions — it's per-session
  by design.
- Persisting current_plan_id to the DB. Lives in process memory and
  resets when the session ends.

## Open Questions

- Should `plan.read` *always* set `current_plan_id`, or only when the
  agent passes a flag like `select: true`? Default proposal: always,
  so the agent doesn't have to learn an extra flag. The visible echo
  in the tool result is the safety net.
- Should `task.read` / `task.update` *also* hint at session state
  (e.g., "the task you read belongs to plan P, which is now the
  current plan")? Default proposal: no — keep the implicit-update set
  to plan ops only. Avoids surprising side effects from a `task.read`.
- If the agent calls `task.create` and the result echoes a different
  `plan_id` than expected, should the runtime mark the session as
  "potentially confused" and require an explicit `plan.read` to
  recover? Default proposal: no — trust the agent to read the tool
  result.

## Companion PRs

- `repo-tools-inherit-repository-scope.md` — repo tools want the
  same `current_plan_id` to infer repository defaults.
- PR #377 — the precedent for inheriting defaults from plan/session.
