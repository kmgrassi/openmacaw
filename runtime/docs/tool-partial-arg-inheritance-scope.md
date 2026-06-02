# Tool Partial-Arg Inheritance Scope

## Premise

Today the planner-facing CRUD tools (`task.update`, `plan.update`,
`scheduled_task.update`, and read-then-modify patterns generally)
require the agent to re-pass values it isn't changing. The agent has
to think: "I only want to change the state; do I need to repeat
title, description, runner_kind, repository?" — and either get it
right or accidentally clear a field with `null`. The system has the
existing row; it should be doing this merge itself.

## Current State

- `task.update`, `plan.update`, and `scheduled_task.update` in
  `apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex`
  and `scheduled_task/tools.ex` build a payload from whatever the
  agent passes and PATCH the row.
- PostgREST PATCH with only the changed columns is already what the
  runtime sends — so unchanged fields *do* survive on the server.
- The risk shows up at the **schema layer**: required-vs-optional
  schemas, validation error messages, and JSON schemas that mark
  fields as required when only the operation type implies the agent
  has to know them.
- A subtler risk: when the agent passes `null` for a field, the tool
  currently writes `null` (clearing the field) rather than leaving
  it alone. The intent — "I don't want to change this" — can't be
  distinguished from "set it to null" today.

## Target State

For every `*.update` tool:

- The only required argument is the row identifier (`task_id`,
  `plan_id`, `scheduled_task_id`).
- All mutable columns are optional. Omitted = unchanged.
- Explicit `null` means "clear this field" only on columns where
  null is a valid value. For non-nullable columns, `null` is an
  error.
- The tool reads the existing row and:
  - validates that the caller's workspace owns it (already done
    today);
  - merges the patch over the row in memory;
  - sends the merged-but-only-changed-fields PATCH to PostgREST.
- The tool result echoes the **resolved row after patch**, with a
  `changed_fields: [...]` list so the agent sees what actually moved.

## Phased Work

### PARTIAL-1 — `task.update` Optional-Field Pass

- Drop all non-id required fields from the `task.update` JSON schema
  (`database_tools.ex` build_update_task_schema or equivalent).
- Add a `read_existing_for_update(task_id, workspace_id, opts)`
  helper that returns the existing row.
- Validate the patch against the existing row (e.g., reject moving
  `state` from `done` back to `draft` if business rules disallow
  that — keep existing validations; this PR is about schema, not
  policy).
- Echo `changed_fields` and the resolved row in the result.

**Independent**: behaviour-preserving for callers that pass the same
fields; lets callers pass fewer.

### PARTIAL-2 — `plan.update` Optional-Field Pass

- Same shape as PARTIAL-1, for plans.
- Notable case: `metadata` is an object; partial-merge semantics for
  metadata require care. Default proposal: top-level merge — agent
  passes `metadata: { foo: 1 }` and only `foo` changes, other keys
  preserved. Deeper nesting is left intact. This is more useful and
  less surprising than full replacement.

**Gates on**: PARTIAL-1 (shared `read_existing_for_update` helper).

### PARTIAL-3 — `scheduled_task.update` Optional-Field Pass

- Same shape, for scheduled tasks in
  `scheduled_task/tools.ex`.

**Gates on**: PARTIAL-1 (shared helper).

### PARTIAL-4 — Reads Echo `etag`/`updated_at` For Optimistic Updates

- Optional follow-on. `task.read` / `plan.read` include the row's
  `updated_at` (or a derived etag) in the result.
- `*.update` tools accept an optional `if_updated_at` argument; if
  set and stale, reject with `{:error, {:stale_row, ...}}`.
- Lets the agent do "read → modify → write" without race conditions
  in multi-agent workspaces.

**Lower priority** — only matters when concurrent edits become a
real concern.

## Distinguishing "Unchanged" From "Clear"

The tricky part is `null`. Today the tool's JSON schema lists nullable
fields as `["string", "null"]`. If the agent passes `description:
null` it currently means "clear description." Some agents pass `null`
as a placeholder when they don't have a value, expecting "no
change."

Proposal: the tool definition declares each column's intent:

- **omit-means-unchanged, null-means-clear** for nullable columns.
- **omit-means-unchanged, null-rejected** for non-nullable columns.

Document this clearly in each tool's description string so the LLM
sees the contract. The result envelope's `changed_fields` array makes
it observable.

## Test Cases

### Unit: omit-means-unchanged

```
given:  task T with title = "Old", description = "D", state = "todo"
when:   task.update with task_id = T, state = "running"
        (no title, no description)
then:   PATCH sent contains only { state: "running" }
        (title and description not included)
and:    after the update, the row still has title="Old", description="D",
        state="running"
and:    result.changed_fields = ["state"]
```

### Unit: null clears nullable column

```
given:  task T with description = "D"
when:   task.update with task_id = T, description = null
then:   PATCH sent contains { description: null }
and:    after the update, description is null
and:    result.changed_fields = ["description"]
```

### Negative: null on non-nullable column

```
given:  task T with name = "N"
when:   task.update with task_id = T, name = null
then:   {:error, {:invalid_null, "name is non-nullable"}}
and:    no PATCH sent
```

### Unit: metadata merges shallowly

```
given:  task T with metadata = { foo: 1, bar: 2 }
when:   task.update with task_id = T, metadata = { foo: 3, baz: 4 }
then:   resulting metadata = { foo: 3, bar: 2, baz: 4 }
and:    result.changed_fields = ["metadata"]
```

### Unit: no-op update returns empty changed_fields

```
given:  task T with title = "T1"
when:   task.update with task_id = T, title = "T1"
then:   no PATCH sent (or PATCH that the DB recognizes as no-op)
and:    result.changed_fields = []
```

### Browser smoke

Extend the planner work-item smoke:

1. Prompt: "Create a plan with one task."
2. Prompt: "Change just the state of that task to in_progress."
3. Confirm the planner calls `task.update` with `task_id` and `state`
   only — not re-passing title/description/etc.
4. Query the row, confirm only `state` changed; `title` and
   `description` are intact.
5. Confirm the result envelope's `changed_fields = ["state"]`.

## Non-Goals

- `task.create` / `plan.create` rules — they keep their existing
  required fields. This scope is about *update* semantics.
- Optimistic concurrency control (PARTIAL-4) on every update —
  optional follow-on.
- Replacing the existing validation policies (state machine, plan
  workspace ownership). This scope is schema/merge behaviour only.

## Open Questions

- Does the codebase have a single update-payload helper, or is the
  PATCH building inline in each tool? If inline (likely), this scope
  factors out a small helper at the same time.
- Are there any `*.update` tools that *should* keep mandatory
  fields beyond the id? `task.update` arguably should require
  `state` when transitioning, to make the agent's intent explicit.
  Default proposal: no — state is optional, agents already say what
  they're changing in their tool call message. The result echoes
  what moved, which is sufficient.
- Does this interact with the `tg_validate_routing_rule_refs`-style
  trigger plans we have elsewhere? Default proposal: no — those run
  on PATCH regardless of which fields are present.

## Companion PRs

- PR #377 — established the create-side inheritance pattern.
- `session-current-plan-id-scope.md` — once `current_plan_id` exists,
  `task.update` could also use it to scope the lookup; not strictly
  needed for this scope.
- `repo-tools-inherit-repository-scope.md` — independent surface, but
  shares the "result envelope echoes source/changed_fields" idea.
