# OQ-08: Re-entry semantics

> Open question #8 from [docs/product-vision.md](../product-vision.md):
>
> "Re-entry semantics. When the agent escalates, what state does it
> pause in? When the human responds, how does the agent pick up
> exactly where it was? Likely tied to `task.state` transitions but
> needs a designed lifecycle, not an ad-hoc one."

## ✅ Decision (2026-04-25): lean on each provider's Agent SDK; we own durable persistence

We researched what OpenAI and Anthropic ship as hardened
primitives so we don't reinvent. Findings:

- **Neither provider ships a "pause for hours/days, then resume"
  primitive.** Their built-ins are tuned for in-process
  conversations, not multi-day escalations.
- **OpenAI Agents SDK** has `session.run()` with
  pause/resume/escalate semantics, plus the Responses API's
  `previous_response_id` for inter-turn continuity.
- **Anthropic Agent SDK** has Sessions
  (`continue`/`resume`/`forkSession`) plus the Memory tool
  (beta, client-hosted). Anthropic's prompt cache TTL has
  regressed to 5min default — caching is **not** a resume
  primitive for human-think-time.
- **MCP Elicitation** is the right semantic for our
  `escalate_to_human` tool ([OQ-06](./oq-06-escalation-policy-schema.md))
  — it's the cross-provider standard for "pause mid-tool-call,
  ask the human, resume on response" with a three-action
  contract (`accept` / `decline` / `cancel`).
- **Anthropic Managed Agents** (announced April 2026) is hosted
  agent runtime with built-in session + credential persistence.
  We **explicitly choose not** to lean on it — locks us into
  a single provider, defeats the LLM-agnostic pillar.

**Concrete decision:**

1. Each runner adapter wraps the appropriate provider's Agent
   SDK session primitive in-process — we don't reinvent
   conversation-state management.
2. **We own the durable persistence layer** (Postgres). The
   runner's in-memory session is the SDK's. The persistent
   snapshot is ours, written every turn boundary.
3. The `escalate_to_human` tool from
   [OQ-06](./oq-06-escalation-policy-schema.md) aligns with
   MCP Elicitation's `accept/decline/cancel` contract so the
   resume protocol works whether the agent reaches us via MCP
   or via direct provider integration.
4. The `escalation` table in this doc is the system of record
   for escalation history — neither provider gives us this for
   free.

See *[What's hardened, what isn't](#whats-hardened-what-isnt)*
below for the per-provider mapping.

## What we know

- The autonomous loop is fundamentally a state machine. Without an
  explicit one, every runner / orchestrator / dashboard combination
  invents its own ad-hoc states and we can't reason about flows.
- The escalation triggers themselves come from
  [OQ-06](./oq-06-escalation-policy-schema.md). This doc covers
  **what happens to the task once it's escalated.**
- Pause/resume must work across orchestrator restarts, runner
  crashes, and indefinite human-think time (escalations may sit for
  hours or days).

## Recommended state machine

```
                ┌─────────────┐
                │   pending   │
                └──────┬──────┘
                       │ dispatch
                       ▼
                ┌─────────────┐
        ┌──────►│   running   │◄─────┐
        │       └──────┬──────┘      │
        │              │             │
        │  resume      │ escalate    │ retry
        │              ▼             │
        │       ┌─────────────┐      │
        └───────│  escalated  │──────┘
                └──────┬──────┘
                       │ abandon / approve
                       ▼
                ┌──────┴──────┐
            ┌───┴───┐    ┌────┴────┐
            │ done  │    │ abandoned│
            └───────┘    └─────────┘
```

States:

- **`pending`** — task created, not yet dispatched.
- **`running`** — actively processing on a runner.
- **`escalated`** — paused, awaiting human input.
- **`done`** — completed successfully (gates green, merged or
  delivered).
- **`abandoned`** — human said no, or cost cap hit and human
  declined to extend.

## Pause snapshot

When a task transitions `running → escalated`, the orchestrator
captures everything needed to resume:

```json
{
  "task_id": "…",
  "snapshot_at": "2026-04-25T14:31:00Z",
  "runner_state": {
    "session_id": "…",
    "turn_count": 12,
    "last_message_id": "…",
    "scratchpad": "<runner-defined opaque blob>",
    "working_branch": "agent/task-…"
  },
  "escalation": {
    "reason": "self_flagged_question",
    "trigger": { "kind": "low_confidence", "score": 0.42 },
    "question_for_human": "Should I drop the trailing slash …?",
    "context_blob": "…",
    "candidate_decisions": [
      { "id": "drop-slash", "label": "Drop the slash" },
      { "id": "keep-slash", "label": "Keep it" },
      { "id": "ask-llm-again", "label": "Try a different model" }
    ]
  }
}
```

Snapshot lives in `work_item.runner_state` (jsonb). Transitions are
written via Postgres advisory locks so we can't lose updates from a
runner racing the orchestrator.

### Runner state is opaque

The orchestrator does **not** care what's in `runner_state`. The
runner serializes whatever it needs (session id, scratchpad,
chain-of-thought prefix). On resume, the orchestrator passes the
blob back to the runner via `Runner.resume(snapshot, human_input)`.
This decouples lifecycle from runner internals.

## What's hardened, what isn't

We lean on each provider's Agent SDK for in-process session
state and on MCP for the elicitation contract. Persistence past
the in-process lifetime is **always our responsibility**.

### Per-provider mapping

| Provider           | In-process session primitive (theirs)                                  | What's hardened                                                | What we still own                                                                                |
|--------------------|------------------------------------------------------------------------|----------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| OpenAI / Codex     | OpenAI Agents SDK `session.run()`; Responses API `previous_response_id`| Inter-turn context compaction; tool-call accounting            | Durable persistence past process lifetime; cross-machine resume                                  |
| Anthropic / Claude | Claude Agent SDK Sessions (`continue` / `resume` / `forkSession`)      | Conversation replay; tool-state continuity                     | Same as above (the SDK persists to disk by default; we substitute Postgres-backed persistence)   |
| OpenAI Realtime    | Ephemeral session token only                                           | Nothing for our use case                                       | Everything — Realtime is not for long pauses; runner-side notes that it's not a resume target    |
| OpenAI-compatible local (Ollama / vLLM / LM Studio) | None (stateless)                                      | Nothing                                                        | Full conversation-history persistence; the runner serializes the message array as `runner_state` |

### The MCP elicitation alignment

When a runner emits an `escalate_to_human` tool call
([OQ-06](./oq-06-escalation-policy-schema.md)), the
orchestrator-side handling matches MCP Elicitation's
three-action contract:

| MCP action  | Our state transition                                            |
|-------------|------------------------------------------------------------------|
| `accept`    | `Runner.resume(snapshot, {kind: :decision \| :reply \| :patch \| :approve, payload: …})` |
| `decline`   | `Runner.resume(snapshot, {kind: :declined, reason: …})` — agent receives the user's "no, do something else" answer and continues |
| `cancel`    | `task.state → abandoned; Runner.cancel(snapshot)` — user dismissed the escalation; the task does not retry |

This means:

- An MCP-aware runner that emits an `elicitation/create` request
  is handled by the same orchestrator code path as a
  non-MCP-aware runner that emits our `escalate_to_human` tool.
- A future runner that *only* speaks MCP (e.g., a third-party
  agent framework that's MCP-native) plugs in without the
  orchestrator caring.

### What we deliberately don't use

- **Anthropic Managed Agents** — single-provider lock-in,
  defeats the LLM-agnostic pillar. Revisit only if a customer
  needs it for compliance reasons that override the pillar.
- **Anthropic prompt cache** as a resume primitive — TTL is too
  short (5min default, 1h available at 2× write cost) for human-
  think-time. Caching stays a per-turn cost optimization, not
  pause-resume infrastructure.
- **OpenAI Threads API quotas** as a substitute for our
  persistence — opaque TTL, no cross-org migration story, locks
  us out of LLM-agnostic.

## Resume protocol

Human responds in dashboard. Possible responses:

1. **Pick a candidate decision** → orchestrator emits a `resume`
   call to the runner with `{decision: "drop-slash"}`.
2. **Free-text reply** → orchestrator emits `resume` with
   `{message: "<text>"}`.
3. **Modify and continue** — human edits the candidate diff
   directly in the dashboard, orchestrator resumes with
   `{patch: "<diff>"}` and the runner integrates the patch as if
   it had produced it.
4. **Approve as-is** — runner had finished but escalated for
   structural rule reasons; human approves → orchestrator skips
   forward to `merge` step without invoking the runner again.
5. **Abandon** → task → `abandoned`, runner gets `cancel` to clean
   up.

The runner contract gets a new callback:

```elixir
@callback resume(session_handle, snapshot, human_response) ::
  {:ok, runner_event} | {:error, term}
```

For runners that don't support resume natively (e.g., a synchronous
shell-based one), `resume/3` is implemented as: tear down the old
session, spin up a new session, replay the relevant context from
`snapshot.runner_state`, then continue from `human_response`. The
abstraction lets the orchestrator not care which strategy is used.

## Escalation table

`escalation` is its own first-class entity, not just a column on
`work_item`:

```sql
create table escalation (
  id uuid primary key,
  work_item_id uuid not null references work_item,
  workspace_id uuid not null,
  triggered_at timestamptz not null,
  trigger_kind text not null,
  payload jsonb not null,
  responded_at timestamptz,
  response_kind text,                 -- 'decision' | 'reply' | 'patch' | 'approve' | 'abandon'
  response_payload jsonb,
  responded_by uuid references "user"
);
```

This gives us:

- audit trail of every human-in-the-loop interaction;
- analytics ("which trigger kinds escalate the most?");
- a multi-turn conversation history if a single task escalates
  more than once.

## Stale escalations

If an escalation is unresponded for
`escalation.delivery.stale_after_days` (default: 7 days; set
`null` to disable — see
[OQ-06](./oq-06-escalation-policy-schema.md)), the task is moved
to `abandoned` automatically with
`response_kind: "auto_abandoned"`. This is to prevent indefinite
zombie tasks from accumulating.

## Concrete next step

- [ ] Add the `task.state` enum migration with the values above.
      Existing rows default to `running` or `done` as appropriate.
      (one PR in `parallel-agent-platform`)
- [ ] Add the `escalation` table migration. (one PR)
- [ ] Implement state-machine transitions in the orchestrator
      (`Workflow.transition(task, event)`). (one PR in
      `parallel-agent-runtime`)
- [ ] Add `Runner.resume/3` to the runner behavior. Implement for
      `Runner.Mock` (full native resume) and `Runner.Codex`
      (replay-based resume). (one PR per runner)
- [ ] Dashboard: escalation queue + response UI with the four
      response shapes. (one PR in `parallel-agent-platform`)

## Open sub-questions

- Should the runner *itself* be able to pause without the
  orchestrator knowing (e.g., "GPU not available, retry in 5
  minutes")? Recommendation: yes, but model it as
  `runner_event: :transient_pause` distinct from escalation; the
  orchestrator just keeps the task in `running` and re-dispatches.
- How long do we keep `runner_state` blobs around after `done`?
  Recommendation: 30 days for debug, then truncate.
