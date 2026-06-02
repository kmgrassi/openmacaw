# Attention Queue & Re-Entry — Runtime Scope

Companion to the platform scope at
[`docs/active/attention-queue-scope.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/attention-queue-scope.md)
in `parallel-agent-platform`. That doc owns the resolution schemas,
API surface, queue UI, and the platform-side state transitions. This
doc owns the **runtime re-entry path** — what happens when a paused
work item becomes queued again because its escalations resolved.

Read the platform scope first. This doc assumes its vocabulary
(`EscalationResolution` schema, `consumed_at` column, the
all-must-resolve invariant, the `:paused_for_human` → `:queued` /
`:cancelled` transition).

## Goal

When the platform transitions a work item out of `:paused_for_human`,
the runtime must:

1. **Detect the transition** through its existing dispatch loop. No
   new push mechanism; the loop already polls `:queued` work items
   for dispatch.
2. **Read all unconsumed resolutions for that work item** and lock
   them as the resumption batch.
3. **Construct a re-entry context** — original conversation history
   from the model-agnostic message store, plus a synthetic resumption
   message that carries the trigger detail and human resolution for
   each escalation in the batch.
4. **Spawn a fresh turn** with that context. The agent runs as if
   the resumption message is its newest input. Whatever was
   in-flight when the pause fired is discarded.
5. **Mark the consumed resolutions** in the same operation so they
   are not re-read on a subsequent pause-and-resume cycle.
6. **Honor override-just-this-once** on structural rules — when the
   resumed turn next runs a structural check, skip checks already
   approved-with-override for the same trigger detail.

Per the design decision in the conversation: re-entry is **stateless
from the agent's perspective**. We don't preserve in-memory state
across the pause. Conversation history is the source of truth; the
resumption message is the agent's first new input after the pause.
Verbatim history in v1; summarization is deferred.

## Current state

### What the orchestrator already does

- **Dispatch loop** in
  `apps/orchestrator/lib/symphony_elixir/orchestrator.ex` polls for
  `:queued` work items and dispatches them. No code change needed
  for the *trigger*; the work item will simply re-appear in the
  queue once the platform transitions it.
- **`:paused_for_human` skip** — added in 4.6's runtime scope (Phase
  R-2). The dispatch loop already skips work items in this state.
  After 4.5 lands, the platform transitions them out; dispatch picks
  them up.
- **Message store** —
  [`model-agnostic-message-store-plan.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/shipped/model-agnostic-message-store-plan.md)
  shipped. Conversation history is persisted per-agent, model-tagged,
  and readable by any future model. This is the source of truth for
  re-entry context.
- **Session construction** — when the orchestrator picks up a work
  item, it constructs a `Session` struct from the agent config,
  loads message history, picks the model client. This is the
  injection point for the resumption message.

### What's missing

- **No resumption-message construction.** Nothing today reads
  `escalation` rows and builds a synthetic message from them.
- **No consumption write.** Nothing sets `consumed_at`.
- **No override-just-this-once tracking.** The structural enforcer
  from 4.6 doesn't know about per-work-item overrides.
- **No `:cancelled` work item handling.** When the platform
  transitions to `:cancelled`, the orchestrator should treat it as
  terminal — release any holds, stop polling, close any open
  observability sessions.

## Proposed model

### Resume detection

Inside the dispatch loop's per-work-item handler
(`SymphonyElixir.Orchestrator.dispatch_work_item/1`), the runtime
must distinguish a *fresh* dispatch from a *resumption* dispatch
because the session bootstrap differs.

Approach:

```elixir
defp dispatch_work_item(work_item) do
  case Attention.unconsumed_resolutions(work_item.id) do
    [] ->
      # Fresh dispatch — normal path.
      Session.bootstrap(work_item)
      |> run_turn_loop()

    resolutions ->
      # Resumption dispatch.
      Session.bootstrap_for_resume(work_item, resolutions)
      |> run_turn_loop()
  end
end
```

`Attention.unconsumed_resolutions/1` queries the platform via
PostgREST (or the existing PostgREST bridge):

```sql
SELECT * FROM escalation
WHERE work_item_id = $1
  AND state = 'resolved'
  AND consumed_at IS NULL
ORDER BY triggered_at ASC;
```

The index added in 4.5's Phase 1 (`escalation_unconsumed` partial
index on `(work_item_id) WHERE consumed_at IS NULL`) makes this
cheap. Multiple resolutions for the same work item come back in
chronological order.

### Building the resumption context

`Session.bootstrap_for_resume/2`:

1. Load the existing message history from the message store (same
   as fresh bootstrap).
2. Generate **one synthetic user message** carrying the resumption
   batch. Format:

   ```
   [Resumption after human review]

   You were paused on this task. While you waited, the following
   were resolved by a human:

   ---
   Reason #1: Structural rule fired.
     • Rule:   path_glob "infra/**"
     • Detail: You touched `infra/cors.tf` while attempting to commit.
   Resolution by Kevin (2026-05-23 14:02):
     • Verdict: APPROVE — this change may proceed.
     • Override just this once: yes
     • Notes:   "Bumping to the new CORS origin list per ticket DEV-481."

   ---
   Reason #2: Resource cap fired.
     • Cap:    max_turns_per_task = 40
     • Detail: You had run 41 turns when paused.
   Resolution by Kevin (2026-05-23 14:03):
     • Verdict: APPROVE_CONTINUE
     • New cap (this work item only): 60
     • Notes:   "Likely needs another 10–15 turns to finish."

   Continue with the task. The pause is over; the human's
   resolution is binding.
   ```

   One message, structured for the model to parse. Tool-call
   carry-over: any tool calls that were in-flight when the pause
   fired are NOT replayed — the resumption is the agent's next
   input after their last completed turn.

3. Append the resumption message to the session's message stream
   (model-agnostic message store gets a new row tagged with the
   resuming model).
4. Pass to `run_turn_loop/1` which proceeds normally.

The resumption message format is a runtime convention; the schema
fields it derives from (kind, trigger_detail, resolution) are the
contract.

### Marking resolutions consumed

After successful bootstrap (the resumption message is appended; the
turn-loop begins), the runtime POSTs to the platform:

```
PATCH /api/escalations/bulk-consume
  body: { escalation_ids: [...] }
  → sets consumed_at = now() for each, only if currently NULL
```

(New endpoint added by this scope on the platform side. Or use
PostgREST directly with an UPDATE — the runtime already writes
through PostgREST for cutover audit rows; same pattern.)

Best-effort persistence per
[`best-effort-persistence-logging.md`](./best-effort-persistence-logging.md):
a failed consume write is logged but does not block the agent's
turn. The next dispatch tick will re-detect the same unconsumed
resolutions; the runtime's `bootstrap_for_resume` is idempotent
in the sense that re-feeding the same resolutions to the agent is
a no-op (the message store will have already recorded the
resumption message; the same one would just write again). Safer
than failing the resume.

To avoid the rare double-write, `bootstrap_for_resume/2` checks
the message store for an existing resumption message tagged with
the resolution ids — if found, skip the message generation and
proceed directly to the turn loop.

### Override-just-this-once tracking

The structural enforcer from 4.6's Phase R-3 needs to know about
per-work-item overrides.

`StructuralEnforcer.check_diff/2` is extended:

```elixir
def check_diff(workspace_id, diff, opts \\ []) do
  work_item_id = Keyword.fetch!(opts, :work_item_id)
  overrides = Attention.active_overrides(work_item_id)

  policy = PolicyCache.get(workspace_id)
  matching_rule = first_match(policy.structural.require_human_for, diff)

  cond do
    is_nil(matching_rule) ->
      :ok

    matches_override?(matching_rule, diff, overrides) ->
      :ok  # human approved this exact case earlier

    true ->
      {:escalate, %EscalationTrigger{kind: :structural, detail: matching_rule}}
  end
end
```

`Attention.active_overrides/1` reads:

```sql
-- DB column names: payload (= contract trigger_detail) and
-- response_payload (= contract resolution). The platform repository
-- layer maps these in API responses; runtime queries directly via
-- the PostgREST bridge so it uses the DB names.
SELECT payload, response_payload
FROM escalation
WHERE work_item_id = $1
  AND trigger_kind = 'structural'
  AND state = 'resolved'
  AND (response_payload ->> 'override_just_this_once')::boolean IS TRUE
  AND (response_payload ->> 'verdict') = 'approve';
```

These overrides apply for the lifetime of the work item only. When
the work item completes (`:done` or `:cancelled`), they implicitly
expire because no further checks happen.

The override-detail comparison (`matches_override?/3`) checks for
exact equality of the trigger detail (DB column `payload`,
conceptually `trigger_detail`). A second touch to a different infra/
file would re-escalate; the override is for the specific file, not
the rule pattern. This matches the platform scope's "override just
this once" language.

### `:cancelled` work item handling

When `dispatch_work_item/1` encounters a work item that has been
moved to `:cancelled` since the orchestrator last saw it (e.g.,
mid-resume), the runtime:

1. Does NOT spawn a turn.
2. Does NOT write a resumption message.
3. Closes any open observability session for the work item.
4. Marks all the now-cancelled work item's open + in_progress
   escalations as consumed (with `consumed_at = now()`) so the next
   pause cycle on this work item — if it somehow re-opens —
   wouldn't replay stale context. (Defensive; cancelled is
   terminal in v1.)

The platform-side auto-resolve-sibling logic in 4.5 (Phase 2)
handles the resolution side; the runtime just respects the terminal
state.

## Phased migration

Tracks platform phases:

### R-1 — `Attention.unconsumed_resolutions/1` + bulk consume

Tracks platform Phases 1 and 2.

- Extend `apps/orchestrator/lib/symphony_elixir/policy/attention.ex`
  (from 4.6's runtime scope) with `unconsumed_resolutions/1` and
  `mark_consumed/1`.
- Add the bulk-consume HTTP client / PostgREST writer.
- Tests with a stub platform: query returns expected rows, consume
  marks them.

### R-2 — `Session.bootstrap_for_resume/2`

Tracks platform Phase 5 (the runtime is the consumer; this is the
core of R-5).

- New helper in
  `apps/orchestrator/lib/symphony_elixir/session/resume.ex`.
- Resumption message format (see above) as a templated formatter.
- Message store write (the synthetic message becomes a real entry).
- Idempotency check: skip if message store already has a resumption
  message for these resolution ids.
- Tests: build the message for each trigger-kind × verdict
  combination; verify the rendered text contains the correct
  structured fields.

### R-3 — Dispatch loop integration

- `dispatch_work_item/1` consults `Attention.unconsumed_resolutions/1`
  and branches.
- `bootstrap_for_resume` is called for the resumption path.
- Smoke test: end-to-end pause → resolve → resume → fresh turn.

### R-4 — Override-just-this-once

- `Attention.active_overrides/1`.
- Extend `StructuralEnforcer.check_diff/2` signature with
  `:work_item_id` opt.
- `matches_override?/3` for exact trigger_detail equality.
- Tests: override applies to first-touch, second different touch
  re-escalates.

### R-5 — `:cancelled` handling

- `dispatch_work_item/1` no-ops for `:cancelled` work items.
- Observability sessions close cleanly.
- Defensive consume of sibling escalations as a safety net.

## Open questions

### OQ-AR-1 — Resumption message length

A work item that escalated 5 times in one pause cycle (after
multiple gate failures resolved as "send back") would have a 5-item
resumption message. Combined with 40 turns of prior history, this
could push the context window of smaller models.

**Tentative answer**: no special handling in v1. The cutover engine
(3.4) already handles "model can't handle context" by escalating
again. If a resumption message itself blows the context window,
that's caught by the cutover floor logic (the resumption tries
again on a higher-tier model). Summarization is deferred.

### OQ-AR-2 — Resumption message: structured JSON or natural language?

The mockup above uses natural language with structure. Should the
runtime instead emit a JSON-shaped message that models can parse
deterministically?

**Tentative answer**: natural language with structure. Modern
frontier models parse natural-language structure reliably and the
text is more useful for the message-history audit trail. A JSON
payload would be less readable for the operator scanning logs and
would still need a natural-language preamble for the model. If
later we find models struggling, we can switch to JSON + a parsing
prompt instruction; defer until we see the problem.

### OQ-AR-3 — What if the model that originally fired the escalation has cutover-skipped models below the floor?

A self-flagged escalation from a frontier model, resumed by the
cutover engine on a mid-tier model — does the mid-tier model
understand the resumption context as well? Cross-tier resumption
could degrade quality.

**Tentative answer**: respect the work item's model_tier_floor as
usual; if the only available model below the floor would have to
be used, the resumption itself escalates (cutover-exhausted with
floor). User sees another attention queue entry to deal with the
underlying availability issue.

### OQ-AR-4 — Tool-call carry-over

If the agent was mid-tool-call when paused (the tool call wasn't
in flight, but the agent's plan was to issue more tool calls in
this turn), the resumption discards the in-progress turn entirely.
The agent's last completed turn is the conversation tail; the
resumption message is the new prompt. Is that the right semantic
for the gate-failure "send back with notes" case where the human
specifically said "you screwed up the test, try again"?

**Tentative answer**: yes. The agent reads "human said: your tests
were failing in stale fixtures; try again" and treats it as a
fresh instruction. The agent is in a clean state — no half-written
diff hanging around in memory. Deterministic.

### OQ-AR-5 — Telemetry for re-entry quality

Do we instrument "did the agent succeed on the turn after
resumption?" so we can later measure if certain trigger kinds /
verdicts produce reliable resumption outcomes?

**Tentative answer**: yes, but as a follow-on. The existing
RuntimeLog can capture per-turn outcomes; we tag the resumption
turn with `resumption_for_escalation_ids: [...]` in its log
metadata. Downstream analytics can join from there. No new table.

## Out of scope

- **Resumption summarization** — v1 replays history verbatim.
- **Resumption against a paused work item that has migrated to a
  different agent** — agent transfer mid-pause is not supported.
  If a workspace deletes the agent while a work item is paused,
  the work item moves to a terminal failure state (handled by
  existing agent-deletion cleanup; documented but not built here).
- **Override expiration beyond work-item lifetime** — overrides
  apply per work item; no persistence across work items.
- **Push notification from platform → runtime when a work item
  resumes** — v1 uses dispatch-loop polling. Push is a perf
  optimization for later.

## Success criteria

1. A paused work item whose all open escalations resolve transitions
   to `:queued` (platform-side) and is picked up by the runtime
   dispatch loop on the next tick.
2. The runtime detects unconsumed resolutions, builds a synthetic
   resumption message with structured detail per resolved
   escalation, appends it to the message store, and spawns a fresh
   turn.
3. After bootstrap, the runtime marks all consumed resolutions
   with `consumed_at = now()`. Re-dispatching the same work item
   without new escalations does not re-replay the resumption.
4. A structural rule resolved with `override_just_this_once: true`
   prevents re-escalation on the same trigger detail within the
   same work item; a different trigger detail (different file or
   different rule) re-escalates.
5. A work item moved to `:cancelled` is no-oped by the dispatch
   loop; observability sessions close.
6. Idempotency: a runtime crash between resumption-message-write
   and consume-write does not produce duplicate resumption
   messages on retry.
7. The end-to-end pause → resolve → resume → fresh-turn flow
   passes a smoke test for each trigger-kind × verdict combination.

When these are true alongside the platform success criteria, Pillar
4.5 closes and the loop is functional end-to-end.
