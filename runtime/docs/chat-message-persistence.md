# Chat Message Persistence — Implementation Plan

Persist WebSocket-streamed chat turns to the Supabase `message` table so session
history survives runtime restarts and shows up in the platform dashboard.

Complements the launcher integration plan; this doc is the self-contained scope
for a single PR (call it **OR-7** in the PR-plan numbering).

---

## Goal

Every chat turn sent or received over runtime `/ws` lands as a row in Supabase
`message`, keyed to a `session_thread` that matches the WS connection scope.
When a client reconnects with the same `(agent_id, workspace_id, session_key)`,
the platform can reload the full transcript from the DB instead of relying on
the in-memory `SessionStore`.

## Why this is needed

- `SessionStore` is a GenServer holding sessions in-process. A restart drops
  every conversation. The platform dashboard has no way to show past runs.
- Execution telemetry in `broker_run` + `broker_task` (from OR-6) records
  *that* a run happened and its token spend — **not the message content**. See
  table split below.
- `apps/orchestrator/docs/runtime_websocket_gateway_contract.md` already calls
  out "durable session transcripts" as a known gap.

## Current state

| Layer | What exists |
|---|---|
| Inbound `chat.send` | `SessionStore.append_user_message/2` at [gateway_socket.ex:143](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L143) — in-memory only |
| Outbound final assistant turn | [gateway_socket.ex:64-82](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L64) — emits WS frame, no DB write |
| Outbound error | [gateway_socket.ex:84-96](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L84) — emits WS frame, no DB write |
| Runner crash | [gateway_socket.ex:98-108](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L98) — emits WS frame, `SessionStore` not notified |
| Session scope | `%{agent_id, workspace_id, session_key}` — matches fields on `session_thread` |
| Ecto foundation | `SymphonyElixir.Repo` (from PR #50) available; `SymphonyElixir.Schema.Agent` is the only schema so far |
| Supabase `message` table | Exists, unused by the orchestrator — `grep -rn message apps/orchestrator/lib/` finds no writers |

## Table relationships we rely on

```
                              ┌────────────────┐
                              │ session_thread │   keyed by (agent_id,
                              │   id, agent_id │   workspace_id, session_key)
                              │   workspace_id │
                              │   session_key  │
                              │   status       │
                              │   last_message │
                              │   input_tokens │
                              │   output_tokens│
                              └────────┬───────┘
                                       │ id
                                       ▼
                              ┌────────────────┐
                              │    message     │   per chat turn
                              │   id           │
                              │   session_id ──┼── FK → session_thread.id
                              │   workspace_id │   (NOT NULL)
                              │   agent_id     │
                              │   role         │   enum: user | assistant | ...
                              │   content      │
                              │   metadata     │
                              │   run_id       │   FK → broker_run.run_id
                              │   created_at   │
                              └────────────────┘
```

**Important:** `message.workspace_id` is `NOT NULL`. Every insert must carry it.
The WS scope already has `workspace_id`, so this is fine.

**`message.role`** is a Postgres enum, not a free-form string. Find the allowed
values in `supabase/generated/types.ts` under `public.Enums.role`. Use them
verbatim — don't invent.

**`message.run_id`** → `broker_run.run_id`. Set this when a turn belongs to a
run so the dashboard can join message history with execution telemetry.

**`message.agent_id`** is always populated from the WS scope. We don't rely on
joining through `session_thread` to learn the agent — every row carries it
directly so dashboard queries stay single-table.

**`message.user_id`** is populated from the WS scope. The browser → platform
`/ws` proxy authenticates the user via JWT; the platform proxy adds
`user_id=<uuid>` as a query param when opening the runtime-side WS. The
runtime trusts that value (the platform has already verified it) and
persists it on every message row. See "WS scope change" below.

**`message.thread_id` is a legacy column.** We leave it nullable and never
populate it. If the platform later wants nested threading, add it then.

### How this differs from existing telemetry

| Table | What it stores | Granularity |
|---|---|---|
| `broker_run` | Run lifecycle, input/output JSON, status, timings | 1 row per agent run |
| `broker_task` | Per-turn token spend, `last_event`, `lease_expires_at` | N rows per run |
| **`message`** | **Actual chat content — role, content, metadata** | **N rows per session** |
| `session_thread` | Session metadata — agent/workspace, token totals, last_message_at | 1 row per (scope) |

The new code writes to `message` and `session_thread`. It does **not** change
`broker_run` / `broker_task` behavior — those keep doing what OR-6 set up.

## Design decisions

### 0. WS scope change: add `user_id`

Today the gateway connection scope is `(agent_id, workspace_id, session_key)`
([session_store.ex:8](../apps/orchestrator/lib/symphony_elixir/gateway/session_store.ex#L8)).
Extend it to `(agent_id, workspace_id, session_key, user_id)`.

- **Platform responsibility** (PL-2 `/ws` proxy): after JWT verification, pass
  the resolved `user_id` as a query-string parameter when opening the runtime
  WS. The runtime does not re-verify the JWT — the platform is the auth
  boundary.
- **Runtime responsibility**: read `user_id` from the connection query params
  in the socket connect callback. Reject the connection if absent. Persist on
  every `message` row and on the `session_thread.user_id` column.

This maps cleanly to the "app-level authz at the platform, DB-level trust at
the runtime" split we already use for service-role Postgres access.

### 1. Who creates the `session_thread` row

**Decision:** the gateway creates or looks up the thread on `"connect"`, not on
`chat.send`. That way the thread exists before the first message insert, and
subsequent reconnects with the same scope reuse the row.

Lookup key: `(agent_id, workspace_id, session_key)`. There's no unique index on
that triple today; add one as part of this PR (migration).

### 2. Where persistence lives in code

**Decision:** a new `SymphonyElixir.MessageLog` module mirroring the shape of
`SymphonyElixir.BrokerLog` (from OR-6). Gateway calls it; gateway doesn't know
about Ecto or Supabase.

Rationale: gateway stays a pure transport. All DB concerns funnel through one
module that's easy to stub in tests and easy to gate on env vars.

### 3. When we write to the DB

Four hook points in `gateway_socket.ex`. All writes are "best effort" — if
Supabase is unreachable, log and continue. Losing a message row is not worse
than losing the in-memory state today.

| Event | Hook | What to insert |
|---|---|---|
| `"connect"` method | [gateway_socket.ex:115](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L115) | `session_thread` upsert (by scope) |
| `"chat.send"` request | [gateway_socket.ex:143](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L143), after `append_user_message` | `message` insert, `role: user` |
| `:gateway_runner_complete` | [gateway_socket.ex:64](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L64), before WS push | `message` insert, `role: assistant`, with `run_id` + token metadata from session |
| `:gateway_runner_failed` | [gateway_socket.ex:84](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L84) | `message` insert, `role: assistant`, `metadata: {error_code, error_message}` — distinguish from success via metadata |

**`:gateway_runner_down`** at [gateway_socket.ex:98](../apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L98) currently doesn't call `SessionStore.fail_run/1`; fix that so the failure path matches `:gateway_runner_failed` and gets the same DB insert. This is a pre-existing bug the PR can incidentally fix.

### 4. Transaction semantics

**Decision:** no cross-table transactions. Each insert is standalone.
`session_thread.last_message_at` is updated by a trigger in the migration so we
don't have to coordinate two writes from Elixir.

Rationale: Ecto supports `Repo.transaction/1` but the cost of a failed
multi-insert rolling back a user message just to avoid a stale
`last_message_at` isn't worth the complexity. A trigger on `message` insert
keeps `session_thread` current cheaply.

### 5. Ordering and idempotency

- Message rows carry `created_at` (defaulted `now()`) and the rows are
  auto-incrementing UUIDs — ordering is preserved by `ORDER BY created_at, id`.
- Inserts are not idempotent. The WS protocol doesn't replay `chat.send` on its
  own, and the gateway only inserts once per event. Don't add a client
  `request_id` dedup key in this PR — scope creep.

### 6. Failure mode

- If `MessageLog.insert_*` fails (network blip, Supabase 5xx), log a warning
  and continue. The WS frame still ships to the client. User-visible latency
  goes up by one failed Supabase round-trip at worst.
- If Supabase env vars are missing entirely (local dev with no DB), the log
  module no-ops cleanly — same pattern as `BrokerLog`.

### 7. Backfill

- Not in scope. Existing in-memory transcripts from live WS sessions are lost
  the first time the runtime restarts after this ships. That matches today's
  durability guarantee (none), and the platform dashboard doesn't read history
  yet, so there's no user-visible regression.

### 8. Dashboard read path

**Decision:** the platform dashboard queries Supabase directly via
`supabase-js`, scoped by the authenticated user's JWT + RLS. The runtime's
only job is to **write** `message` rows; it does not expose any read API for
history.

This mirrors the pattern already in place for `broker_run` / `broker_task`,
where PL-5 reads them through Supabase Realtime / PostgREST. Runtime writes,
platform reads. No new WS method, no new HTTP endpoint on the runtime, no
coordination needed.

RLS on `message` should allow read access for users who are members of the
message's `workspace_id` — add a policy in the same migration that creates
the unique-scope index. If RLS is already broadly configured elsewhere, use
the same helper (e.g. `is_workspace_member()`).

---

## PR scope: single PR (OR-7)

One PR, ~400-600 lines. The work splits cleanly into parts but none are
individually useful without the others.

### Checklist

#### Ecto schemas (new)

- [ ] `SymphonyElixir.Schema.SessionThread` at
      `lib/symphony_elixir/schema/session_thread.ex`. Minimum columns:
      `id, agent_id, workspace_id, session_key, status, label, model, input_tokens, output_tokens, last_message_at, metadata, created_at, updated_at`.
      Do **not** add every column on the live table — only what the gateway
      reads or writes.
- [ ] `SymphonyElixir.Schema.Message` at `lib/symphony_elixir/schema/message.ex`.
      Columns: `id, session_id, workspace_id, agent_id, user_id, run_id, role, content, metadata, created_at`.
      Use `Ecto.Enum` for `role` with exactly `[:user, :assistant]`. Other enum
      values may exist in the live Postgres enum (system, tool, etc.) — the
      runtime doesn't emit them, so keep the Elixir-side enum tight.
      Do **not** map `thread_id` on the schema (see "Legacy columns" below).

#### Migration (new)

- [ ] `supabase/migrations/<yyyymmddhhmmss>_or7_session_thread_unique_scope.sql`:
      - `CREATE UNIQUE INDEX session_thread_scope_uidx ON session_thread (agent_id, workspace_id, session_key);`
      - Trigger on `message INSERT` that `UPDATE session_thread SET last_message_at = now(), updated_at = now() WHERE id = NEW.session_id;`.
      - RLS policy on `message`: `USING (is_workspace_member(workspace_id))` so
        the dashboard can read through `supabase-js` scoped by user JWT. If
        `is_workspace_member` or an equivalent helper isn't already in the
        authz schema, copy the pattern from `session_thread` / `agent` RLS.

#### `MessageLog` module (new)

- [ ] `lib/symphony_elixir/message_log.ex` — mirror `BrokerLog`'s shape. The
      `scope` type carries `agent_id`, `workspace_id`, `session_key`, and
      `user_id`. Every insert writes `agent_id` and `user_id` onto the
      `message` row directly from the scope.
      Functions:
      - `upsert_session_thread(scope, opts) :: {:ok, session_thread_id} | {:error, term}` — also sets `session_thread.user_id`.
      - `record_user_message(scope, session_thread_id, content, opts) :: :ok | {:error, _}` — `role: :user`.
      - `record_assistant_message(scope, session_thread_id, content, run_id, metadata) :: :ok | {:error, _}` — `role: :assistant`, final content only (no per-delta rows).
      - `enabled?/0` — mirrors `BrokerLog.enabled?/0` so tests that assert "no writes when Supabase absent" still work.

#### Gateway wiring

- [ ] Extend the connection-scope parsing at socket-init to read `user_id`
      from the query string. Reject the connect when it's absent (clear error
      message; the platform proxy is the boundary that's supposed to supply it).
- [ ] Widen `SymphonyElixir.Gateway.SessionStore.scope` type from
      `{agent_id, workspace_id, session_key}` to
      `{agent_id, workspace_id, session_key, user_id}`. Threading this change
      through `ensure_session`, `append_user_message`, `start_run` etc. is the
      bulk of this bullet.
- [ ] In `handle_request(id, "connect", ...)`: after `SessionStore.ensure_session`,
      call `MessageLog.upsert_session_thread/2` and stash the returned
      `session_thread_id` in the socket state under `state.session_thread_id`.
- [ ] In `handle_request(id, "chat.send", ...)`: after
      `SessionStore.append_user_message/2`, call
      `MessageLog.record_user_message/4` with the full scope (carries user_id).
- [ ] In `handle_info(:gateway_runner_complete, ...)`: after
      `SessionStore.complete_run/1`, before emitting the final WS frame, call
      `MessageLog.record_assistant_message/5` with the `run_id` and the
      session's token counters in metadata. **Final content only** — do not
      persist per-delta events.
- [ ] In `handle_info(:gateway_runner_failed, ...)`: same pattern as complete,
      but metadata includes `error_code` + `error_message`.
- [ ] In `handle_info(:gateway_runner_down, ...)`: call
      `SessionStore.fail_run/1` (pre-existing gap), then record the same
      error-style assistant message.

#### Tests

- [ ] Unit tests for `MessageLog` using Mox-stubbed `Req` (or whatever HTTP
      client it uses) covering success + failure paths. If the migration PRs
      land first, use Mox against the Repo instead.
- [ ] Integration test in `test/symphony_elixir_web/gateway_socket_test.exs`
      asserting that a full `connect` → `chat.send` → runner-complete flow
      results in two `MessageLog` calls (one user, one assistant) via a stub
      `MessageLog` module injected at test boot.
- [ ] `:live_db`-tagged test that opens a real WS session against the local
      launcher (or via function-call harness), runs one turn, then reads back
      both rows from `message` via `Repo.all/1`. **Read-only after write** —
      cleans up inserted rows in an `on_exit/1` using `Repo.delete_all/2`.
- [ ] Snapshot test: a WS crash mid-turn (`:gateway_runner_down`) inserts an
      error-role assistant message instead of leaving the session in a hung
      state.

### Non-goals (do not do in this PR)

- Don't backfill historical in-memory sessions.
- Don't change the `broker_run` / `broker_task` writeback behavior.
- Don't read messages back for client-side replay — that's a platform/dashboard
  concern, tracked separately.
- Don't add RLS. The runtime connects as service role and bypasses RLS; per-user
  authz is a platform-side concern (see the broader auth discussion in the
  launcher integration plan).

### Out-of-band dependencies

- **Depends on the Ecto migration for `tracker/database.ex` landing** only if
  you want to use `Repo.insert` calls. If those PRs are still outstanding, the
  `MessageLog` module can start on plain Supabase REST via
  `SymphonyElixir.Supabase` + `Req` (same shape as `BrokerLog` today) and
  later migrate to Ecto in a follow-up. Pick one — don't do both.

---

## Decisions locked in

The questions that were open in the first draft are now decided:

| Question | Decision |
|---|---|
| `message.role` enum values | **`[:user, :assistant]`** only. Other values in the live Postgres enum (system, tool, etc.) are not emitted by the runtime; keep the Elixir-side enum tight so an unknown value would fail at insert, not silently round-trip. |
| `message.thread_id` | **Legacy column.** Don't map it on the Ecto schema; don't populate it. |
| `message.user_id` | **Populate.** Platform `/ws` proxy adds `user_id` to the WS URL query params after JWT verification. Runtime reads it into scope and persists it on every row. See Design §0. |
| `message.agent_id` | **Populate.** Comes from the existing WS scope; write it directly on every row instead of joining through `session_thread`. |
| Streaming intermediate deltas | **Final content only.** Deltas stay in-memory via `SessionStore`. One assistant row per completed turn. |
| Dashboard read path | **Platform reads Supabase directly via `supabase-js`**, gated by RLS on `workspace_id`. Runtime only writes — no `sessions.history` WS method, no new HTTP endpoint. Mirrors the `broker_run` read path from PL-5. |

## Remaining open items

None that block OR-7. Revisit if the platform later wants nested threading
(populate `thread_id`) or per-delta streaming replay (richer writes).
