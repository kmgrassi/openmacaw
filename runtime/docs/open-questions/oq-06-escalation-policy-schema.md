# OQ-06: Escalation policy schema

> Open question #6 from [docs/product-vision.md](../product-vision.md):
>
> "Escalation policy schema. What's the actual shape of 'when does
> the agent surface to the user'? Per-workspace rules
> (`require_human_for: [paths, deps, schema_migrations]`)? Per-task
> confidence thresholds (LLM-flagged uncertainty)? A combination?
> Decide before building the policy editor UI."

## ✅ Decision (2026-04-25)

**Escalation is a first-class citizen, backed by a new database
table.** Not a derived state, not a string in `task.state` only —
a proper `escalation` row that the orchestrator, the dashboard,
the audit log, and analytics all read from. Migration is on the
critical path. (Schema is specified in
[OQ-08](./oq-08-re-entry-semantics.md#escalation-table); this doc
covers *when* to write a row, OQ-08 covers *what* the row looks
like.)

**The four trigger kinds stay** — structural, self-flagged,
resource, gate-failure — OR'd together. They cover different
failure modes and we want all of them.

**But the heart of the system is self-flagged, implemented as a
tool call.** Every agent gets an `escalate_to_human` tool. The
prompt teaches the LLM, in plain language, when to call it
("ambiguous intent, missing context, destructive action you can't
undo, decision a teammate would want to weigh in on"). The LLM
calls the tool with structured arguments — question, context,
candidate options. The orchestrator writes an `escalation` row.

This is the same pattern as [OQ-01](./oq-01-plan-format.md)'s
`create_plan` tool: the LLM is constrained by a function-call
schema, not asked to emit JSON inside text. No threshold parsing,
no "is the model under 0.7 confident" guesswork — the model
either calls the tool or it doesn't.

The other three trigger kinds remain orchestrator-side checks
that fire independently of the LLM's tool calls.

## What we know

- Escalation is the central UX promise: *the human only sees what
  needs them.* If escalation is wrong, either (a) we wake the user
  for nothing or (b) we silently make a decision they should have
  owned.
- There are at least four orthogonal **escalation triggers** in
  practice:
  1. **Structural** — touched a path / dependency / file the user
     marked as "humans always own this."
  2. **Self-flagged** — the LLM itself raises a question or flags low
     confidence.
  3. **Resource** — the task exceeded a budget (turns, time, cost,
     retries).
  4. **Gate failure** — an auto-merge gate (tests, lint, peer review)
     came back negative and auto-recovery already failed.
- These are not mutually exclusive. The same task can hit multiple.
- The escalation policy lives in `gateway_config` (versioned,
  scoped) — same place as routing
  ([OQ-03](./oq-03-routing-config-schema.md)).

## Recommended schema

`gateway_config.body.escalation`:

```json
{
  "schema_version": "1",
  "escalation": {
    "structural": {
      "require_human_for": [
        { "kind": "path_glob",  "pattern": "infra/**" },
        { "kind": "path_glob",  "pattern": "**/migrations/**" },
        { "kind": "dependency_change" },
        { "kind": "schema_migration" },
        { "kind": "secret_rotation" }
      ]
    },
    "self_flagged": {
      "tool_enabled": true,
      "guidance_prompt_id": "escalation-guidance-v1"
    },
    "resource": {
      "max_turns_per_task": 40,
      "max_wallclock_minutes": 60,
      "max_cost_usd": 5.00,
      "max_retries": 3
    },
    "gate_failure": {
      "after_auto_recovery_attempts": 1
    },
    "delivery": {
      "channels": ["dashboard", "email"],
      "quiet_hours": { "start": "22:00", "end": "08:00",
                       "tz": "America/Los_Angeles" },
      "stale_after_days": 7
    }
  }
}
```

`stale_after_days` is the auto-abandon threshold for unresponded
escalations. Drives the stale-escalation behavior described in
[OQ-08](./oq-08-re-entry-semantics.md#stale-escalations). Set to
`null` to disable auto-abandon (escalations sit forever until
manually resolved).

### Trigger semantics

- **Structural** is hard: any match → escalate. No override at task
  level. (You don't want a single rogue task to bypass the "humans
  own migrations" rule.) Checked by the orchestrator on every diff
  before merge.
- **Self-flagged** is the LLM calling its `escalate_to_human` tool
  (see *[Self-flagged: the `escalate_to_human` tool](#self-flagged-the-escalate_to_human-tool)*
  below). The orchestrator does **not** try to infer escalation
  from the LLM's text or numeric confidence — only an explicit
  tool call counts.
- **Resource** caps are hard ceilings. Hitting any cap pauses the
  task and escalates with a "task hit limit X — extend, abort, or
  let the agent try a smaller version" prompt. Checked by the
  orchestrator at each turn boundary.
- **Gate failure** is the most common: the agent tried, gates went
  red, the agent tried to repair, gates still red → escalate with
  the gate output and the diff that failed. Fired by the gate
  runner ([OQ-10 (deferred)](./deferred/oq-10-per-vertical-gate-hooks.md)) when
  `auto_recovery_attempts` is exhausted.

### Self-flagged: the `escalate_to_human` tool

Every agent the orchestrator dispatches gets an
`escalate_to_human` tool injected into its tool list, the same way
the planning agent gets `create_plan` ([OQ-01](./oq-01-plan-format.md)).
The LLM calls the tool when *it* judges human input is needed.

#### Tool definition

```jsonc
{
  "name": "escalate_to_human",
  "description": "Pause this task and request input from the human owner. Use when you cannot proceed responsibly without their decision. See the escalation guidance in your system prompt for when to call this.",
  "input_schema": {
    "type": "object",
    "required": ["reason_kind", "question", "context_summary"],
    "properties": {
      "reason_kind": {
        "type": "string",
        "enum": [
          "ambiguous_intent",
          "missing_context",
          "policy_uncertain",
          "destructive_action_unverified",
          "out_of_scope",
          "stuck_after_retries",
          "other"
        ],
        "description": "Best-fit category. Used for analytics and routing in the dashboard."
      },
      "question": {
        "type": "string",
        "description": "One sentence asking the human exactly what you need. Plain language. Address them directly.",
        "minLength": 5,
        "maxLength": 300
      },
      "context_summary": {
        "type": "string",
        "description": "What you've done so far, what you tried, why you're stuck. 3–8 sentences. The human should be able to act without re-reading the whole transcript.",
        "minLength": 20,
        "maxLength": 2000
      },
      "candidate_options": {
        "type": "array",
        "description": "If you can name distinct options, list them with short pros/cons. Optional but strongly preferred — it lets the human respond with a one-click decision.",
        "items": {
          "type": "object",
          "required": ["id", "label"],
          "properties": {
            "id":    { "type": "string", "pattern": "^[a-z0-9_-]+$" },
            "label": { "type": "string", "maxLength": 80 },
            "pros":  { "type": "string", "maxLength": 300 },
            "cons":  { "type": "string", "maxLength": 300 }
          }
        },
        "maxItems": 5
      },
      "preferred_option_id": {
        "type": "string",
        "description": "Which option you'd pick if you had to. Optional — surfaces in the UI as 'agent recommends'."
      },
      "urgency": {
        "type": "string",
        "enum": ["normal", "blocking_other_tasks"],
        "description": "Soft hint. 'blocking_other_tasks' means tasks downstream of this one cannot proceed."
      }
    }
  }
}
```

#### Guidance prompt (system-level, injected by the orchestrator)

The orchestrator injects a guidance block into the system prompt
of every dispatched agent. Versioned by `guidance_prompt_id` in
the policy schema so we can iterate without redeploying runners.
Example v1:

> You have an `escalate_to_human` tool. Use it whenever any of
> these are true:
>
> 1. **Ambiguous intent.** The user's request could be reasonably
>    interpreted in materially different ways and picking wrong
>    would waste meaningful work.
> 2. **Missing context.** You cannot answer without information
>    you don't have access to (a credential, a private decision,
>    a preference the user hasn't stated).
> 3. **Policy uncertain.** You're unsure whether the workspace's
>    rules allow what you're about to do.
> 4. **Destructive and unverified.** The action would delete data,
>    drop a column, force-push, send mail, post publicly, or
>    otherwise be hard to undo, and the user did not explicitly
>    pre-authorize this specific action.
> 5. **Stuck after retries.** You have tried three or more
>    distinct approaches and none worked.
>
> When you call the tool, write the `question` directly to the
> human in plain language. Do not call this tool to ask for
> clarification you could resolve by reading the codebase or
> docs you have access to.

This is *the* spec for self-flagged escalation. The threshold
approach is rejected: LLM-emitted confidence scores are too poorly
calibrated to drive a binary decision, and a tool call lets the
LLM articulate *why* — which is what the human needs to act.

#### What the orchestrator does on a tool call

1. Validate args against the schema (reject + retry on invalid).
2. Insert an `escalation` row (schema in
   [OQ-08](./oq-08-re-entry-semantics.md#escalation-table)).
3. Transition `task.state` → `escalated`.
4. Capture runner snapshot for resume.
5. Trigger delivery (dashboard, email, push) per
   `escalation.delivery` config.
6. The runner's tool call returns success — the agent stops
   emitting tokens and waits.

When the human responds, see [OQ-08](./oq-08-re-entry-semantics.md)
for the resume protocol.

#### What this rules out

- Numeric confidence thresholds. (Untrustworthy.)
- Regex / heuristic detection of "I'm not sure" in agent text.
  (Brittle and the agent can game it.)
- Per-runner custom escalation events. All escalations from any
  runner go through the same tool, the same row, the same UI.

### Trigger combination

The schema is **all triggers active simultaneously**, OR'd. There is
no need for fancy AND/NOT logic in v1.

### Why structural rules are list-of-typed-rules, not a free-form
expression

Structural rules need to be **inspectable**: a workspace admin
should be able to look at the list and reason about it. A free-form
expression language buys flexibility we don't yet need at the cost
of clarity. Add expression rules later if a customer needs them.

### Per-task overrides

- A planner *can* set `task.metadata.escalation.cost_cap_usd_override`
  to *lower* (never raise) the workspace cap.
- A planner *cannot* override structural rules — those are policy.
- This asymmetry is the right one: cheap-and-safe overrides are
  fine; relaxing safety rails requires editing the workspace policy
  itself.

## Re-entry

When an escalation fires, the task moves to state `escalated`. See
[OQ-08](./oq-08-re-entry-semantics.md) for the resume protocol.

## Build sequence

Escalation is first-class — that means a real database migration
on the critical path, not a column added later.

1. **Migration: `escalation` table** (schema in
   [OQ-08](./oq-08-re-entry-semantics.md#escalation-table)). Indexes
   on `(workspace_id, responded_at is null)` for the
   "outstanding" queue and on `work_item_id` for the task
   detail view. (one PR in `parallel-agent-platform`)
2. **Migration: `task.state` enum + transitions.** Add the
   `escalated` state and the `state` column if not present.
   Backfill existing rows. (one PR — same migration is used by
   [OQ-08](./oq-08-re-entry-semantics.md))
3. **JSON Schema for `gateway_config.body.escalation`.** Versioned
   per [OQ-03](./oq-03-routing-config-schema.md) — but escalation
   policy is hand-edited as a unit, so it stays in
   `gateway_config`, not its own relational table. (one PR in
   `parallel-agent-platform`)
4. **`escalate_to_human` tool.** Implement the tool definition and
   the orchestrator-side handler that converts a tool call into an
   `escalation` row + state transition. Inject the tool into every
   dispatch frame. (one PR in `parallel-agent-runtime`)
5. **Guidance-prompt versioning.** Land the v1 guidance prompt
   text in a versioned file (`prompts/escalation-guidance-v1.md`).
   The orchestrator injects it into the system prompt of every
   dispatched agent. (one PR in `parallel-agent-runtime`)
6. **Structural-rule checker.** Implement
   `Escalation.check_structural(diff, workspace_id)`. Runs on
   every diff before the merge gate. (one PR in
   `parallel-agent-runtime`)
7. **Resource-cap checker.** Implement
   `Escalation.check_resource(task)` invoked at every turn
   boundary. Caps drawn from `gateway_config.body.escalation.resource`.
   (one PR in `parallel-agent-runtime`)
8. **Gate-failure → escalation bridge.** When the gate runner
   ([OQ-10 (deferred)](./deferred/oq-10-per-vertical-gate-hooks.md)) reports
   `auto_recovery_attempts` exhausted, write an `escalation` row
   with `trigger_kind = "gate_failure"`. (one PR in
   `parallel-agent-runtime`)
9. **Escalation queue UI.** Dashboard page showing outstanding
   escalations for the user, with the four response shapes (pick
   option / free text / patch / approve / abandon — see
   [OQ-08](./oq-08-re-entry-semantics.md#resume-protocol)).
   One-click decisions where `candidate_options` exist. (one PR
   in `parallel-agent-platform`)
10. **Notification delivery.** Land in-app first; email next; push
    last. Honor `delivery.quiet_hours` for non-urgent kinds, never
    suppress `urgency = "blocking_other_tasks"`. (one PR per
    channel in `parallel-agent-platform`)
11. **Analytics.** Per-trigger-kind escalation rate, per-reason-kind
    breakdown, per-workspace and per-runner-kind heat maps. Helps
    us see which runners flag too often / too rarely. (deferred —
    one PR after the data is flowing)

## Open sub-questions

- Do users want **per-task-kind** rules (e.g., "video tasks
  escalate at 10 USD, code tasks at 5 USD")? Recommendation: yes,
  add `escalation.overrides_by_kind` once we have a second vertical
  in production.
- How do we represent "the user already responded but hasn't acted
  yet"? Recommendation: an `escalation` table tracks the
  back-and-forth; task stays `escalated` until the user explicitly
  resumes.
