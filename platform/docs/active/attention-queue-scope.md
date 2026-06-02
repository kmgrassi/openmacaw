# Attention Queue & Re-Entry — Scope

## Goal

[Pillar 4.6's policy work](./policy-trust-dial-scope.md) produces
`escalation` rows: agent X tried to do thing Y, policy said no, work
item is paused. Without somewhere for those rows to land in front of a
human and a way for the agent to resume after the human responds,
escalations are dead-ends.

This scope (vision Pillar 4.5) closes that loop:

1. **The attention queue** — a workspace-scoped page at
   `/workspace/:id/attention` that lists open escalations, lets a
   human claim one, presents a kind-specific resolution form, and
   records the resolution.
2. **Per-trigger-kind resolution payloads** — typed schemas in
   `contracts/escalation-resolution.ts` so each kind's resolution has
   the structure the runtime needs to re-enter the agent
   intelligently. All kinds share a universal `notes?` carve-out for
   free-text annotation.
3. **The all-must-resolve invariant** — a work item that has multiple
   open escalations stays paused until every one of them is resolved.
   The dashboard groups by work item so a human sees them together.
4. **Re-entry handoff to the runtime** — when the last open
   escalation on a work item resolves, the work item transitions to
   `:queued`. The runtime picks it up via its existing dispatch loop,
   reads the resolved escalations (those with no `consumed_at`),
   constructs a resumption context, spawns a fresh turn. (The runtime
   side is the
   [companion runtime scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/attention-queue-runtime-scope.md);
   this doc owns the trigger and the data shape.)
5. **No expiry** — escalations sit indefinitely until a human acts.
   We display "open for N days" as a UI cue computed from
   `triggered_at`, but there's no state transition or auto-action on
   stale escalations. (This was a design decision; adding expiry is
   purely additive later if a use case demands it.)
6. **`verdict: "cancel"` terminates the work item** — a human can
   choose to abandon the work item entirely as their resolution. The
   work item moves to a terminal `:cancelled` state instead of
   `:queued`.

This is the consumer side of 4.6. It also closes the loop on
[3.4 Intelligent cutovers](./intelligent-cutovers-scope.md), whose
`escalated_exhausted` and `escalated_floor` outcomes were already
writing to the `escalation` table via the runtime's
`Attention.escalate/3`.

## Current state

### What 4.6 gave us (assumed shipped)

- `escalation` table with `trigger_kind` ∈ `{structural, self_flagged,
  resource, gate_failure}`, `trigger_detail jsonb`, `state` ∈ `{open,
  in_progress, resolved}`, `resolution jsonb`, `policy_version`.
- `EscalationPolicy` schema in `contracts/escalation-policy.ts`.
- `POST /api/escalations` route for runtime writes.
- `:paused_for_human` work item state (added in 4.6's harper-server
  migration).
- `escalate_to_human` tool implementation.

### What's missing

- **No resolution schemas.** `escalation.resolution` is typed `jsonb`
  with no Zod validation. A PATCH today could write anything; the
  runtime has no contract to rely on.
- **No `consumed_at` column** to track which resolutions the runtime
  has already incorporated into a resumption.
- **No attention queue page.** The
  `apps/web/src/pages/` layout doesn't have a workspace-scoped
  attention surface. The workspace home has no badge for open
  escalations.
- **No claim / resolve API routes.** `GET /api/workspaces/:id/escalations`
  and `PATCH /api/escalations/:id` are placeholders mentioned in
  4.6's scope but not implemented yet (4.6 only built `POST`).
- **No work-item-resumption trigger.** Nothing today watches for "the
  last open escalation on a work item just resolved" and transitions
  the work item state.
- **No work-item terminal-cancel transition.** Today's work item
  states don't include `:cancelled` from this path.

## Proposed model

### Resolution payload schemas

New file `contracts/escalation-resolution.ts`:

```typescript
import { z } from "zod";

// Universal carve-out: every resolution can include human notes.
// Picked out into a base because we want it on every kind.
const baseFields = {
  notes: z.string().max(2000).optional(),
};

export const StructuralResolutionSchema = z.object({
  kind: z.literal("structural"),
  verdict: z.enum(["approve", "reject", "cancel"]),
  override_just_this_once: z.boolean().default(false),
  ...baseFields,
});

export const SelfFlaggedResolutionSchema = z.object({
  kind: z.literal("self_flagged"),
  // One of:
  //  - chosen_option_id: human picked one of the agent's offered options
  //  - custom_response:  human wrote a free-text response (no options
  //                      offered, or "Other")
  //  - verdict: "cancel" terminates the work item without responding
  chosen_option_id: z.string().min(1).max(64).optional(),
  custom_response: z.string().max(4000).optional(),
  verdict: z.enum(["respond", "cancel"]).default("respond"),
  ...baseFields,
}).refine(
  (r) => r.verdict === "cancel" || r.chosen_option_id || r.custom_response,
  "respond verdict requires chosen_option_id or custom_response"
);

export const ResourceResolutionSchema = z.object({
  kind: z.literal("resource"),
  verdict: z.enum(["approve_continue", "reject", "cancel"]),
  // Only meaningful when verdict === "approve_continue".
  // Raises the relevant cap for this work item only — does NOT edit
  // the workspace policy.
  new_cap: z.number().nonnegative().optional(),
  ...baseFields,
});

export const GateFailureResolutionSchema = z.object({
  kind: z.literal("gate_failure"),
  verdict: z.enum(["merge_anyway", "send_back", "cancel"]),
  ...baseFields,
});

export const EscalationResolutionSchema = z.discriminatedUnion("kind", [
  StructuralResolutionSchema,
  SelfFlaggedResolutionSchema,
  ResourceResolutionSchema,
  GateFailureResolutionSchema,
]);

export type EscalationResolution = z.infer<typeof EscalationResolutionSchema>;
```

The `kind` discriminator must match the `escalation.trigger_kind` of
the row being resolved — validated at PATCH time. Any kind can include
`notes` (universal carve-out per design).

`verdict: "cancel"` is available on **all four kinds** and means
"abandon the work item." The resolution writes through and the work
item moves to `:cancelled` (terminal). The agent does not resume.

### `consumed_at` column

Harper-server migration: add to the `escalation` table:

```sql
ALTER TABLE escalation
  ADD COLUMN consumed_at timestamptz;

CREATE INDEX escalation_unconsumed
  ON escalation (work_item_id) WHERE consumed_at IS NULL;
```

Semantics:
- `consumed_at` is `NULL` when the resolution has not yet been
  incorporated into a work-item resumption.
- The **runtime** sets `consumed_at = now()` when it reads the
  resolution as part of a re-entry context. (See runtime scope.)
- Once consumed, the resolution is part of message history; the
  runtime never re-reads it.

This handles the "work item gets paused → resumed → re-paused" cycle
cleanly. Each pause cycle's resolutions are consumed in one batch when
the work item resumes.

### Repositories and routes

`apps/api/src/repositories/escalations.ts` (extending 4.6's `create`-only):

```typescript
list(workspaceId: string, filters: {
  state?: "open" | "in_progress" | "resolved";
  triggerKind?: TriggerKind;
  agentId?: string;
  workItemId?: string;
  unresolvedOnly?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ items: Escalation[]; nextCursor?: string }>;

get(escalationId: string): Promise<Escalation>;

claim(escalationId: string, userId: string): Promise<Escalation>;
// Transitions open → in_progress; sets claimed_by_user_id = userId.
// Idempotent if already claimed by same user; conflict if claimed by another.

releaseClaim(escalationId: string, userId: string): Promise<Escalation>;
// in_progress (claimed by userId) → open.

resolve(
  escalationId: string,
  resolution: EscalationResolution,
  userId: string,
): Promise<{ escalation: Escalation; workItemTransition?: WorkItemTransition }>;
// in_progress → resolved.
// Validates resolution.kind matches escalation.trigger_kind.
// Returns the work-item transition (if any) that fired as a side
// effect — see "Resolve → resume trigger" below.
```

Routes:

```
GET    /api/workspaces/:workspaceId/escalations
GET    /api/escalations/:id
POST   /api/escalations/:id/claim
DELETE /api/escalations/:id/claim
PATCH  /api/escalations/:id          (resolve)
```

Schema migration for `claimed_by_user_id`:

```sql
ALTER TABLE escalation
  ADD COLUMN claimed_by_user_id uuid REFERENCES "user"(id),
  ADD COLUMN claimed_at timestamptz;
```

### Resolve → resume trigger

When `resolve()` succeeds, it runs inside the same transaction:

1. Update the resolved escalation row.
2. Count `open + in_progress` escalations remaining for the same
   `work_item_id`. (Both are unresolved.)
3. **If count is 0**:
   - **If any resolved escalation for this work item has
     `resolution.verdict === "cancel"`**, transition the work item to
     `:cancelled` (terminal). Do not resume.
   - **Otherwise**, transition the work item from
     `:paused_for_human` to `:queued`. The runtime's dispatch loop
     picks it up on the next tick.
4. **If count > 0**, no work-item transition. The work item stays
   paused until the remaining escalations resolve.

This is the **all-must-resolve invariant** — implemented as a simple
remaining-count check after each resolve, in a transaction so the
state is consistent.

### Work-item state machine additions

Harper-server migration extends the work-item state CHECK constraint:

```sql
-- Existing states stay valid. New states added by this scope:
-- :paused_for_human  (added in 4.6)
-- :cancelled         (added here, terminal)
```

Legal transitions:

| From | To | Trigger |
|---|---|---|
| `queued` / `in_progress` | `paused_for_human` | escalation written |
| `paused_for_human` | `queued` | all escalations resolved without cancel |
| `paused_for_human` | `cancelled` | any resolved escalation had verdict=cancel |
| `paused_for_human` | (stays paused) | resolve happens but other escalations open |

Only the resolve flow transitions out of `paused_for_human` — the
runtime never auto-resumes.

### Attention queue page

Route: `/workspace/:id/attention`.

Layout:

```
┌─ Attention — workspace name ────────────────── 7 open ─┐
│                                                         │
│  Filter: [All kinds ▼] [All agents ▼] [Unclaimed ▼]    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ◉ Coding agent — work_item: "Refactor auth"     │   │
│  │   Structural · open · 2 days ago                │   │
│  │   Touched path `infra/cors.tf` — schema rule    │   │
│  │   [Claim & resolve]                             │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ◉ Planner — work_item: "Plan Q3 cleanup"        │   │
│  │   Self-flagged · in_progress (Kevin) · 4h ago   │   │
│  │   "Should I split this PR or keep it one?"      │   │
│  │   [View]                                        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Show resolved escalations: [past 7 days ▼]            │
└─────────────────────────────────────────────────────────┘
```

Per-row detail panel (opens inline or as side panel):

- **Trigger context**: the rule that fired, with a link to the
  current policy version that produced it.
- **Agent context**: last N messages, files-touched summary, time
  spent on this work item.
- **Resolution form**: rendered per `trigger_kind` (see below).
- **Claim/release controls**: if unclaimed, "Claim & resolve" claims
  to current user and shows the form. If claimed by current user,
  "Release" plus the form. If claimed by another user, read-only
  with name.
- **Cancel work item button**: shortcut to resolve-with-cancel
  without filling the kind-specific form.

### Per-kind resolution forms

Each `trigger_kind` gets a focused React component:

**Structural** (`StructuralResolutionForm.tsx`):
```
┌─ Resolve: structural rule ────────────────────────────┐
│ Rule that fired: path_glob "infra/**"                 │
│ File touched: infra/cors.tf                           │
│                                                        │
│ Verdict:                                               │
│   ◉ Approve (allow this change to proceed)            │
│   ○ Reject (agent should revise and retry)            │
│   ○ Cancel work item                                  │
│                                                        │
│ ☐ Override just this once (don't apply to next time)  │
│                                                        │
│ Notes (optional):                                      │
│ ┌──────────────────────────────────────────────────┐  │
│ │                                                  │  │
│ └──────────────────────────────────────────────────┘  │
│                                  [Cancel] [Resolve]   │
└────────────────────────────────────────────────────────┘
```

**Self-flagged** (`SelfFlaggedResolutionForm.tsx`):

When the agent provided options:
```
┌─ Resolve: agent question ─────────────────────────────┐
│ Agent's question:                                      │
│   "This file imports a deprecated module. Should I    │
│    migrate it now or open a follow-up?"               │
│                                                        │
│ Pick one:                                              │
│   ○ Migrate now (option: "migrate")                   │
│   ◉ Open a follow-up (option: "follow_up")            │
│   ○ Other (custom response)                           │
│                                                        │
│ Notes (optional): ...                                  │
│                          [Cancel work item] [Resolve] │
└────────────────────────────────────────────────────────┘
```

When the agent did NOT provide options, just a textarea for the
custom_response.

**Resource** (`ResourceResolutionForm.tsx`):
```
┌─ Resolve: resource cap hit ───────────────────────────┐
│ Cap that fired: max_turns_per_task = 40               │
│ Current value: 41                                      │
│                                                        │
│ Verdict:                                               │
│   ◉ Approve continuation                              │
│       New cap (just this work item): [60   ]          │
│   ○ Reject (agent stops on this task)                 │
│   ○ Cancel work item                                  │
│                                                        │
│ Notes: ...                                             │
│                                       [Resolve]       │
└────────────────────────────────────────────────────────┘
```

**Gate failure** (`GateFailureResolutionForm.tsx`):
```
┌─ Resolve: gate failure ───────────────────────────────┐
│ Failed gate: tests                                     │
│ Auto-recovery attempts exhausted: 1 / 1               │
│                                                        │
│ Verdict:                                               │
│   ○ Merge anyway (override the gate)                  │
│   ◉ Send back to agent (retry with notes below)       │
│   ○ Cancel work item                                  │
│                                                        │
│ Notes (passed to agent):                              │
│ ┌──────────────────────────────────────────────────┐  │
│ │ The test failure is in stale fixtures — replace │  │
│ │ them with the new format.                       │  │
│ └──────────────────────────────────────────────────┘  │
│                                       [Resolve]       │
└────────────────────────────────────────────────────────┘
```

Note: `notes` is universal but the prompt label changes contextually
("Notes" vs "Notes (passed to agent)") so the user understands what
the agent will see.

### Workspace home: attention badge

The existing workspace home gets an attention indicator:

```
┌─ Workspace ───────────────────────────────── [Attention ⚠ 3] ─┐
```

Clicking goes to `/workspace/:id/attention`. Count is open +
in_progress. Polled every 30s; debounced.

## DB migrations

Harper-server changes for this scope are enumerated in
[`harper-server/docs/vision-gaps-migrations-scope.md`](https://github.com/harper-hq/harper-server/blob/main/docs/vision-gaps-migrations-scope.md)
(M4, plus optional hardening M9 for the `cancelled` state).

## Phased migration

### Phase 1 — Resolution schemas + consumed_at + claim columns

- `contracts/escalation-resolution.ts` with the discriminated union.
- Harper-server migration: `consumed_at`, `claimed_by_user_id`,
  `claimed_at` columns on `escalation`; index on
  `(work_item_id) WHERE consumed_at IS NULL`.
- Extend work-item state CHECK to include `:cancelled`.
- Schema sync.

### Phase 2 — List / detail / claim / resolve API routes

- `apps/api/src/repositories/escalations.ts` extended with `list`,
  `get`, `claim`, `releaseClaim`, `resolve`.
- Routes wired in `apps/api/src/routes/`.
- `resolve()` runs in a transaction with the work-item transition
  side effect.
- Validation: resolution.kind must match escalation.trigger_kind.
- Tests cover the transition matrix (single escalation, multiple,
  cancel verdict).

### Phase 3 — Attention queue page (read-only)

- New route at `/workspace/:id/attention`.
- Queue list with filters (kind, agent, claimed/unclaimed).
- Detail panel that displays trigger detail + agent context.
- No resolution forms yet — clicking a row opens the panel but the
  resolve button is greyed.
- Workspace home gets the attention badge.

### Phase 4 — Per-kind resolution forms

- Four form components.
- Wired into the detail panel.
- Submit hits `PATCH /api/escalations/:id`.
- Optimistic UI: row moves to resolved immediately, rolls back on
  error.

### Phase 5 — Runtime re-entry

See companion runtime scope. Consumes resolved escalations, builds
re-entry context, spawns fresh turn.

### Phase 6 — Polish

- "Show resolved escalations: past 7 days" filter.
- Attention badge count caching / WebSocket-driven update if the
  realtime channel is available.
- Empty states ("no open escalations" / "no resolved in the past 7
  days").
- Keyboard shortcuts on the queue (`j`/`k` to navigate, `c` to
  claim).

## Open questions

### OQ-AQ-1 — Where does "agent context" in the detail panel come from?

The detail panel needs to show "what the agent was doing" — last N
messages, files touched, time spent. Today the message store
(model-agnostic-message-store) has the messages but no "files
touched" summary.

**Tentative answer**: v1 shows the last 5 messages from the message
store and the work_item.title. "Files touched" is deferred (requires
git diff inspection per work item). Doesn't block resolution; just a
nice-to-have for context.

### OQ-AQ-2 — When a `cancel` verdict comes in, what about other open escalations on the same work item?

A work item has two open escalations. User resolves the first with
`cancel`. The second is still `open`. Do we:

- **A**: Leave the second open (it's still a real escalation, just
  on a work item that no longer exists meaningfully).
- **B**: Auto-resolve the second with a synthetic `cancel` resolution.
- **C**: Block cancellation if other escalations are open ("resolve
  the others first").

**Tentative answer (B)**: when a cancel verdict transitions the work
item to `:cancelled`, also auto-resolve any sibling open escalations
on the same work item with `resolution: { kind: <theirs>, verdict:
"cancel", notes: "auto-resolved with work item cancellation" }`.
Same user as the cancel verdict, same timestamp. Keeps the queue
clean.

### OQ-AQ-3 — Re-claim semantics

If a user claims an escalation and walks away for an hour without
resolving, should the claim expire? Or stay claimed indefinitely
until released or until another user steals it?

**Tentative answer**: claim expires after 30 minutes of inactivity
on that escalation (no PATCH attempts, no detail-panel-open ping).
Auto-released back to open. Implemented as a periodic platform-side
job (the only platform-side cron we add — distinct from the no-cron
expiry decision because this is operational, not policy).

### OQ-AQ-4 — Override-just-this-once on structural rules

`StructuralResolutionSchema.override_just_this_once` lets a human
say "approve this case but don't loosen the policy." The agent's
next attempt should not re-escalate on the same path. How does the
runtime know?

**Tentative answer**: the resolution payload travels with the
work-item resumption context. The runtime, when it next dispatches
a structural check for this work item, consults the recent resolved
escalations and skips checks already approved-with-override for the
same trigger detail. After the work item completes, the override
expires (it's not workspace-wide).

### OQ-AQ-5 — Realtime updates for queue freshness

The queue badge polling every 30s is fine for low-volume
workspaces. For a busy workspace with many agents, a fresh
escalation could sit unnoticed for 30s. Is that acceptable, or do
we want WebSocket / Supabase Realtime push?

**Tentative answer**: 30s polling is acceptable for v1. Realtime
push via the existing platform → web channel is a Phase 6 polish
item if users complain about staleness.

## Out of scope

- **Email / Slack delivery channels** — see 4.6's deferred phases.
  Dashboard only here.
- **Workspace policy edits via attention queue.** A user resolving a
  structural-rule escalation cannot "loosen the policy permanently"
  from the resolution form — they must go to the policy editor.
  `override_just_this_once` is the only one-shot override.
- **Multi-user collaboration on a single escalation.** Only one
  human claims; only one resolves. Comments / threads / "agree" are
  out of scope.
- **Audit log of who-resolved-what beyond what `escalation.resolved_by`
  already records.** A separate audit log is OQ-08 follow-on.
- **Bulk operations.** No "resolve all of these the same way." If
  it becomes a request, add it later.
- **Notification snooze separate from claim.** Claim implies "I'm on
  it." We don't have a separate "snooze for 4 hours" because there's
  no notification surface to snooze in v1.

## Success criteria

1. The `EscalationResolutionSchema` round-trips for all four kinds,
   rejects mismatched `kind` vs `trigger_kind`, accepts `notes` on
   every kind, and accepts `verdict: "cancel"` on every kind.
2. A workspace with 3 open escalations on the same work item: the
   work item stays in `:paused_for_human` until all 3 resolve.
   Resolving the 3rd transitions to `:queued` in the same
   transaction.
3. A `cancel` verdict on any escalation transitions the work item
   to `:cancelled` immediately; sibling open escalations on the
   same work item auto-resolve with `verdict: "cancel"`.
4. `/workspace/:id/attention` lists all open + in_progress
   escalations grouped by work item; clicking a row opens a
   detail panel with the appropriate per-kind resolution form.
5. Claim is exclusive: a second user attempting to claim a
   claimed escalation gets a 409. Releasing or 30-minute timeout
   makes it reclaimable.
6. Resolving an escalation sets `state=resolved`, `resolved_at`,
   `resolved_by`, `resolution`, and leaves `consumed_at=NULL` until
   the runtime reads it.
7. The runtime
   ([companion scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/attention-queue-runtime-scope.md))
   picks up the now-queued work item, reads its unconsumed
   resolutions, spawns a fresh turn with the human's decisions in
   context, and marks the resolutions consumed.
8. The workspace home attention badge shows open + in_progress
   count, polled every 30s, click-through to the attention page.

When these are true, vision-gap 4.5 closes and Pillar 4's
escalation loop is functional end-to-end: agent escalates → human
sees it → human resolves → agent resumes with the decision.
