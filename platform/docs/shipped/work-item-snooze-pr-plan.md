# Work-Item Snooze PR Plan

**Status:** scoping draft, 2026-04-30
**Owner:** TBD
**Goal:** Let users **and any agent with the right tool grant** snooze a
work_item until a chosen wall-clock time. The manager scheduler
naturally skips snoozed items; nothing about the agents themselves
pauses.

> **This replaces the earlier "pause agent" framing.** The runtime
> [explicitly rejects](../../../parallel-agent-runtime/apps/orchestrator/docs/manager-agent.md)
> an agent-level enabled / paused flag at line 339:
> *"kill-switching is a credential / cadence concern, and a separate
> boolean would drift out of sync with reality."* The unit of
> time-deferral in this system is the **work_item**, via `next_poll_at`.

---

## 1. Where things stand today

The runtime already has the primitive. Nothing on the platform side
exposes it to humans, and the agent tool that exists is manager-only
and takes a relative-seconds duration only.

**What exists**

- **`work_items.next_poll_at`** column ([packages/supabase-schema/src/database.types.ts:4171](packages/supabase-schema/src/database.types.ts:4171)).
  The Manager Scheduler selects rows where `next_poll_at IS NULL OR
  next_poll_at <= now()`
  ([parallel-agent-runtime / apps/orchestrator/docs/manager-agent.md:362](../../../parallel-agent-runtime/apps/orchestrator/docs/manager-agent.md:362)).
  Snoozing = writing a future timestamp to that column.
- **Manager's `snooze(work_item_id, seconds)` tool** —
  [manager-agent.md:418](../../../parallel-agent-runtime/apps/orchestrator/docs/manager-agent.md:418)
  is the existing in-runtime primitive. Manager only.
- **Webhook wake-up:** webhook handlers bump `next_poll_at = now()` to
  pull a snoozed item forward
  ([manager-agent.md:387-391](../../../parallel-agent-runtime/apps/orchestrator/docs/manager-agent.md:387)).
  This is the existing "wake now" mechanic.
- **Platform work-item routes:** [apps/api/src/routes/work-items.ts:46](apps/api/src/routes/work-items.ts:46)
  exposes `GET /api/workspaces/:workspaceId/work-items`,
  `DELETE /api/workspaces/:workspaceId/work-items/:workItemId`,
  `POST /api/work-items`, plus webhook receivers.
- **Contract:** [contracts/work-items.ts](contracts/work-items.ts) defines
  `WorkItemProjectionSchema` — but it does **not** currently include
  `next_poll_at`, `last_polled_at`, or `poll_cadence_seconds`.
- **Web work-item view:** `apps/web/src/routes/WorkspaceItems.tsx`
  renders the list.

**What's missing**

- The `snooze` tool only accepts **seconds**, not a wall-clock `until`.
  A user telling the planner "pause this until 9pm" needs the agent to
  emit a tool call with an absolute timestamp.
- The `snooze` tool is **manager-only**. Other agents (planning, coding)
  cannot call it because they don't have it on their allowlist.
- **No platform API** for users to snooze a work_item.
- **No UI control** — `WorkspaceItems.tsx` has no snooze button or
  snoozed-state badge.
- The work-item **projection doesn't surface `next_poll_at`**, so
  even if the UI wanted to render "snoozed until 9pm" it can't read it.

---

## 2. Product shape

### A. UI snooze (human-driven)

On a work_item row / detail surface, a **Snooze** button opens a
picker: *1 h · 4 h · until 9am · until tomorrow · custom datetime ·
indefinite*. Picking writes `next_poll_at` and surfaces a
`Snoozed until 9:00 PM` chip with a **Wake now** button that clears
`next_poll_at` (sets to `null` so the next manager tick picks it up).

### B. Agent tool (LLM-driven)

Any agent whose tool grant includes `snooze_work_item` can call:

```json
{
  "name": "snooze_work_item",
  "arguments": {
    "work_item_id": "wi_123",
    "until": "2026-04-30T21:00:00-07:00",
    "reason": "user asked to defer until tonight"
  }
}
```

So the user can say to the planner *"pause this item until 9pm"* and
the planner resolves "9pm" against the workspace's local clock, emits
the tool call, and the work_item is snoozed. The manager keeps
ticking; it just won't pick this item up until 9pm.

### Out of scope for this plan

- Recurring snoozes / cron — `scheduled_task` exists for that and
  is a separate scoping doc.
- Snoozing whole plans / batches in one click — call out as
  follow-up; the primitive supports it but the UI cost is non-trivial.
- Snoozing the *agent* — explicitly rejected by runtime invariant.

---

## 3. Design decisions worth flagging up front

| Decision | Choice | Why |
|---|---|---|
| Column for snooze state | Existing `work_items.next_poll_at` only | No new column. The runtime already enforces this gate; introducing a parallel `snoozed_until` would drift. |
| Audit / "who snoozed this" | New `event_log` rows: `kind: 'work_item.snoozed' \| 'work_item.woken'` with actor + reason | Matches the runtime's existing event-log pattern. Keeps `work_items` row flat. |
| Tool input shape | Accept either `until` (ISO-8601 string) **or** `seconds` (positive int), exactly one | `until` matches natural-language requests ("9pm"), `seconds` matches the manager's existing `snooze` semantics. One tool, two modes. |
| Timezone resolution | Caller's responsibility | Agent system prompt includes workspace timezone + current ISO time; tool input is always absolute UTC ISO. Tool body never parses "9pm". |
| Indefinite snooze | `until: "9999-01-01T00:00:00Z"` plus an explicit `indefinite: true` flag echoed back in projection | Avoids null-as-meaningful (we already use null = "ready now"). UI renders "Snoozed indefinitely" when `indefinite` is true. |
| Wake-now semantics | `next_poll_at = NULL` (drop to "ready"), not `now()` | Matches the runtime's `IS NULL OR <= now()` predicate. Either works; null is cleaner because it means "no schedule, run on next tick." |
| Tool exposure | Universal tool registered once; per-agent grant via the existing tool-allowlist mechanism | Same model as `read_artifact_state` etc. Planner / coding / manager opt in independently. |
| Auth | `requireAuth: true` + `requireWorkspaceAccess(userId, workspaceId)` (existing helper at [apps/api/src/routes/work-items.ts:30](apps/api/src/routes/work-items.ts:30)) | Reuse the existing pattern from list / delete routes. |

---

## 4. PR plan

Six small PRs. Land in order; PRs 4 and 5 are independent and can run
in parallel.

### PR 1 — Contracts

**Repo:** this monorepo.

**Changes** in [contracts/work-items.ts](contracts/work-items.ts):

1. Extend `WorkItemProjectionSchema` with:
   ```ts
   next_poll_at:    z.string().datetime().nullable(),
   last_polled_at:  z.string().datetime().nullable(),
   poll_cadence_seconds: z.number().int().positive(),
   snooze: z
     .object({
       indefinite: z.boolean(),
       reason:     z.string().nullable(),
       snoozed_at: z.string().datetime(),
       snoozed_by: z.discriminatedUnion("kind", [
         z.object({ kind: z.literal("user"),  user_id:  z.string().uuid() }),
         z.object({ kind: z.literal("agent"), agent_id: z.string().uuid() }),
       ]),
     })
     .nullable(),
   ```
   `snooze` is derived (joined from latest `event_log` snoozed-row); it
   is `null` when `next_poll_at` is null or in the past.

2. New file `contracts/work-item-snooze.ts`:
   ```ts
   export const SnoozeWorkItemRequestSchema = z
     .object({
       workspaceId: z.string().uuid(),
       workItemId:  z.string().uuid(),
       until:       z.string().datetime().optional(),
       seconds:     z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
       indefinite:  z.boolean().optional(),
       reason:      z.string().max(500).optional(),
     })
     .refine(
       (v) =>
         [v.until, v.seconds, v.indefinite].filter(Boolean).length === 1,
       { message: "Exactly one of until, seconds, or indefinite is required" },
     );
   export const WakeWorkItemRequestSchema = z.object({
     workspaceId: z.string().uuid(),
     workItemId:  z.string().uuid(),
   });
   export const SnoozeWorkItemResponseSchema = z.object({
     work_item: WorkItemProjectionSchema,
   });
   ```

**Validation:** `pnpm -C apps/api run validate` (the API consumes these
contracts; type errors will surface there).

**Risk:** projection schema change is observed by every consumer of
`/api/workspaces/:workspaceId/work-items`. Per [CLAUDE.md](CLAUDE.md)
§No Backwards Compatibility Shims — add the fields, do not version the
endpoint. Web side updates in PR 4.

---

### PR 2 — Platform API endpoints

**Repo:** this monorepo.

**Routes** in [apps/api/src/routes/work-items.ts](apps/api/src/routes/work-items.ts):

- `POST /api/workspaces/:workspaceId/work-items/:workItemId/snooze`
  - body: `SnoozeWorkItemRequest` (workspace/workItemId verified
    against URL params).
  - resolves `until` from body: explicit `until` → as-is; `seconds` →
    `now() + seconds`; `indefinite` → `9999-01-01T00:00:00Z`.
  - writes `work_items.next_poll_at = until`.
  - inserts an `event_log` row with kind `work_item.snoozed`,
    `actor: { kind: "user", user_id: ... }`, and `reason`.
  - returns the refreshed projection.
- `POST /api/workspaces/:workspaceId/work-items/:workItemId/wake`
  - body: `WakeWorkItemRequest`.
  - writes `work_items.next_poll_at = NULL`.
  - inserts an `event_log` row with kind `work_item.woken`.
  - returns the refreshed projection.

**Service** in `apps/api/src/services/work-item-snooze.ts` (new) — own
the resolution math, the Supabase update, and the event-log write so
both this PR and PR 3 (the tool, when it routes through the platform)
can reuse one code path. Use `assertSupabaseSuccess()` per
[CLAUDE.md](CLAUDE.md) §Surface errors.

**Routes table** in `apps/web/src/api/routes.ts` — add
`workItemSnooze(workspaceId, workItemId)` and
`workItemWake(workspaceId, workItemId)`.

**Tests** (`apps/api/tests/work-items.test.ts`):

- `snooze` with `until` writes the timestamp and event-log row.
- `snooze` with `seconds` resolves to a future `next_poll_at`.
- `snooze` with `indefinite` sets the sentinel and projection echoes
  `indefinite: true`.
- `snooze` without any of the three returns 400.
- `snooze` with `until` in the past returns 400.
- `wake` clears `next_poll_at` and writes a `woken` event.
- Workspace scoping: snoozing an item in another workspace returns 403.
- The projection now contains `next_poll_at` and (when applicable) the
  `snooze` block.

**Validation:** `pnpm -C apps/api run validate`.

---

### PR 3 — Runtime: universal `snooze_work_item` tool

**Repo:** `parallel-agent-runtime`.

**Changes** (sketch — exact module names per the runtime's tool
registry; verify at impl time):

1. **Extend the existing `snooze` tool** at
   `apps/orchestrator/lib/symphony_elixir/manager/tools.ex` to accept
   either `seconds` (existing) or `until` (new ISO-8601 string).
   Same write semantics: bump `next_poll_at`. Reject if neither / both.
2. **Promote the tool from manager-only to universal** by registering
   it in the shared tool registry referenced by
   [docs/universal-tool-calling-plan.md](docs/universal-tool-calling-plan.md).
   New canonical name: `snooze_work_item`. The manager's existing
   `snooze` becomes an alias resolved through the registry — **no
   compatibility shim** beyond the registry's normal alias mechanism
   ([CLAUDE.md](CLAUDE.md) §No Backwards Compatibility Shims).
3. **Allowlist plumbing.** The planner's allowlist
   ([docs/planning-agent-readonly-architecture.md](docs/planning-agent-readonly-architecture.md))
   today excludes write tools. Add `snooze_work_item` to the planner's
   allowed set explicitly — it's a state-change but it doesn't write
   code, doesn't move money, doesn't escalate. Coding agents get it by
   default. Per-workspace overrides still possible via
   `gateway_config.config_json.runners.<role>.tool_allowlist`.
4. **Event log.** The tool writes the same `event_log` rows the API
   route writes (PR 2 service is the source of truth for shape). Set
   `actor: { kind: "agent", agent_id: <calling agent> }`.

**System prompts** — update the planner and coding-agent system prompts
to include:

> The current time is `<ISO timestamp>` and the workspace timezone is
> `<IANA zone>`. When a user asks to "pause" or "defer" a work_item to
> a specific time, call `snooze_work_item` with `until` set to the
> resolved absolute ISO timestamp.

**Tests:** unit tests for the tool resolver — `seconds` / `until` /
neither / both / past-`until` / unauthorized agent caller.

---

### PR 4 — Web UI

**Repo:** this monorepo.

**Components** (new):

- `apps/web/src/components/work-items/SnoozeButton.tsx` — popover with
  *1 h · 4 h · until 9am · until tomorrow · custom datetime ·
  indefinite* + free-text reason. Calls `snoozeWorkItem` (new client in
  `apps/web/src/api/work-items.ts`).
- `apps/web/src/components/work-items/SnoozedBadge.tsx` — renders when
  projection has `snooze != null`. Shows relative + absolute time, who
  snoozed it, and a **Wake now** button. Indefinite renders
  "Snoozed indefinitely".

**Wiring:**

- `apps/web/src/routes/WorkspaceItems.tsx` — add `<SnoozeButton />` per
  row when `snooze == null`, otherwise `<SnoozedBadge />`. Sort
  snoozed items to the bottom (or behind a filter; pick at impl time
  based on what looks right in the dev server).
- React Query: invalidate the workspace work-items query on
  snooze/wake success. Existing query key.

**Manual test plan** ([CLAUDE.md](CLAUDE.md) §Testing UI):

1. `pnpm run dev`, log in via **Use dev credentials**.
2. Snooze a work_item for 1 minute. Confirm badge appears, time is
   correct.
3. Wait 1 minute, refetch. Badge clears (since `next_poll_at <= now()`,
   projection's `snooze` is null).
4. Snooze indefinitely → badge reads "Snoozed indefinitely". **Wake
   now** → badge disappears.
5. Snooze for *yesterday* via custom picker → button disabled; if
   forced, API returns 400 and a toast shows.
6. Check `.run-logs/api.log` for the mutation; check browser console
   for errors.

**Validation:** `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`.

---

### PR 5 — Diagnostics + docs

**Repo:** this monorepo.

- Extend the diagnostic endpoint (per [CLAUDE.md](CLAUDE.md)) to
  surface a work_item's `next_poll_at` and the latest snooze
  `event_log` row when present.
- Update [docs/manager-agent-onboarding.md](docs/manager-agent-onboarding.md):
  short note that the manager's "Status" line is unaffected by snooze
  — snoozed items just don't appear in the next batch.
- Update [docs/end-to-end-local-runbook.md](docs/end-to-end-local-runbook.md)
  with a "verify snooze locally" section.
- Cross-link from the runtime's [manager-agent.md](../../../parallel-agent-runtime/apps/orchestrator/docs/manager-agent.md)
  Toolset section to this plan so the universal-tool migration is
  discoverable from the runtime side.

---

## 5. Cross-cutting concerns

- **Race: snooze arrives mid-tick.** The current tick may have already
  selected the item. The snooze takes effect from the *next* tick.
  Acceptable — same model as the manager's own `snooze` tool today.
- **Concurrent snooze + wake.** Both are idempotent writes to one
  column. Last write wins. Audit log preserves the sequence.
- **Indefinite-sentinel collisions.** `9999-01-01` is far enough away
  that "is this snoozed forever?" never produces false positives in
  any human lifetime. The projection field `indefinite` exists so
  consumers don't have to know the sentinel.
- **Tool grants drift.** If an agent's allowlist isn't updated, the
  tool just isn't visible. No silent failure — the LLM can't call what
  it doesn't see.
- **Webhook bumps.** Existing webhook handlers that set
  `next_poll_at = now()` will *un-snooze* an item. That's correct: a
  webhook event is precisely the kind of "thing happened, look at
  this now" signal that should override a snooze. Note in the
  `SnoozedBadge` UI: "May be woken early by repo activity."
- **No backwards-compat shims.** The renamed tool, the projection
  shape change, and the new endpoints all change at once across the
  three repos in coordinated PRs. No dual-format support
  ([CLAUDE.md](CLAUDE.md) §No Backwards Compatibility Shims).

---

## 6. Open questions

1. **Should `reason` be required when an agent calls the tool?** Bias
   toward yes — gives a user-facing audit trail showing *why* the
   planner deferred something. UI snoozes can leave reason blank.
2. **Indefinite snooze: sentinel timestamp or nullable column?** Plan
   above uses a sentinel + `indefinite` flag in the projection. Could
   instead add a `snoozed_indefinitely boolean` column on `work_items`.
   Sentinel is cheaper but uglier; explicit column is cleaner but a
   migration. Defer until first review.
3. **Default tool grants for the planner.** The planner's
   read-only architecture
   ([docs/planning-agent-readonly-architecture.md](docs/planning-agent-readonly-architecture.md))
   was a deliberate hard line. `snooze_work_item` is a write but not a
   *code* write. PR 3 needs sign-off from the planning-agent owner
   before flipping the allowlist.
4. **Multi-select snooze in the UI.** Out of scope here, but trivial
   given the primitive. Worth a follow-up issue.

---

## 7. Effort estimate

| PR | Repo | Approx size |
|----|------|-------------|
| 1 — contracts | platform | XS — schema additions only |
| 2 — API endpoints | platform | M — 2 routes + service + ~8 tests |
| 3 — runtime tool | runtime | M — extend tool, registry, allowlists, prompts |
| 4 — web UI | platform | M — 2 components + wiring + manual QA |
| 5 — diagnostic + docs | platform | XS |

Total ~3-5 days of focused work. PRs 1 + 2 land first as a foundation;
PR 4 and PR 3 can land in parallel once the contract is published.
