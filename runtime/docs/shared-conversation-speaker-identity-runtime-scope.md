# Shared, Speaker-Tagged Conversation — Runtime Scope

Runtime companion to the platform doc
`parallel-agent-platform/docs/active/shared-conversation-speaker-identity-scope.md`
(the `CONVO-*` workstream of the Shared Agents initiative). This doc covers
the **runtime** side only; PR prefix here is `RUNTIME`.

The other three workstreams of the initiative (membership/invites,
multi-workspace navigation, authorization hardening) have **no runtime
component** — they live entirely in the platform and harper-server. The
runtime's only role in shared agents is the conversation itself.

## Premise

The runtime is where a shared conversation actually becomes shared or not:
it loads the prior conversation for a run, converts it into the provider
message array, and records inbound user messages. Today, for a single human
per agent, this is fine. For a **shared agent** (two members talking to the
same agent), three things must hold, and the runtime owns all three.

Current state (modules, kept high-level on purpose):

- **`message_log.ex`** loads history filtered by agent (plus optional
  workspace / session) and records inbound user messages with the sender's
  `user_id` taken from the scope.
- **`chat_gateway.ex`** builds that scope (including `user_id`) from the
  inbound request.
- **`message_history.ex`** converts stored rows into the provider message
  array — and in doing so **flattens every human turn to a bare
  `{role: "user", content}`, dropping the author.**
- The `message` table already carries `user_id` per row, and
  `session_thread.user_id` is nullable. The schema supports a shared thread,
  **but the runtime's thread lookup keys on `session_key`, not `user_id`** —
  so a shared thread also requires a shared/canonical `session_key`. See
  `RUNTIME-1`; this is the real partition key, and the crux of the work.

So the data needed is already persisted; the runtime just doesn't *load it
as a shared thread* or *carry the author into the prompt*.

Decision (already taken, platform-side): **one shared, speaker-tagged
thread** per `(workspace, agent)`.

## PRs (runtime)

### `RUNTIME-1` — Load the shared thread for `(workspace, agent)`

Implements the runtime side of `CONVO-1`.

The determining factor for "shared vs. split" is **`session_key`, not
`user_id`**. `MessageLog.fetch_session_thread/2` resolves the
`session_thread` row by `(agent_id, workspace_id, session_key)`, and
`ChatGateway` takes `session_key` from the inbound request; if the two
members' clients send different session keys, they get separate threads —
and separate histories — even for the same `(workspace, agent)`. (Today
`create_session_thread` also stamps the row with the creating member's
`user_id`, but that column is descriptive and is **not** part of the
lookup.)

This PR makes the shared thread actually shared:

- Establish a **canonical, stable `session_key` for the shared
  `(workspace, agent)` thread** so every member resolves to the same
  `session_thread` row. Decide and state who owns this: either the platform
  always sends the same key for a shared agent, or the runtime
  derives/canonicalizes it (e.g. keys the shared thread on
  `(workspace, agent)` and ignores the client-supplied `session_key`). This
  is the crux of the PR, not an afterthought.
  **Decision for RUNTIME-1:** the runtime owns canonicalization for browser
  chat and uses `<workspace_id>:<agent_id>`, ignoring the client-supplied
  websocket `session_key` for shared chat partitioning.
- Set the shared thread's `user_id` to `NULL` on create (it is a shared, not
  per-user, thread), and confirm inbound messages from any member attach to
  that one row.
- *Independent; can start immediately. Coordinate the `session_key` contract
  with the platform `CONVO-1` PR.*

### `RUNTIME-2` — Resolve speaker display names

Implements the runtime side of `CONVO-2`.

- When loading history, resolve each message's `user_id` → a display name
  (lookup against the `user` table via the existing PostgREST client
  pattern; cache per run to avoid N+1).
- For the current turn, the speaker is already in scope; reuse the same
  resolution so names are consistent across historical and live messages.
- *Independent; can start immediately.*

### `RUNTIME-3` — Inject speaker identity into the prompt

Implements `CONVO-3` — the core change.

- In the history → provider-message conversion (`message_history.ex`),
  annotate each user turn with its author so the model can distinguish
  "Dana asked…" from "Kevin asked…".
- Use the provider-agnostic message content prefix
  `<display name> says:\n<message>` for user turns with a known speaker
  label, including the live user turn when the sender can be resolved.
- A **single-author** workspace should look unchanged (or the annotation
  should be harmless/clean) so solo agents are unaffected.
- *Depends on `RUNTIME-2` (needs the resolved names).*

## Parallelization

`RUNTIME-1` and `RUNTIME-2` are independent and can start in parallel.
`RUNTIME-3` depends on `RUNTIME-2`. The whole stream is independent of the
platform MEMBER/NAV/AUTHZ work and can be exercised locally by inserting or
posting messages with different `user_id`s against the same
`(workspace, agent)` — no second human and no invite flow required.

Loose coordination only: the prompt representation in `RUNTIME-3` and the
platform's author-attribution UI (`CONVO-4`) are independent surfaces that
both read the same `user_id`; they don't block each other.

## Validation

- `cd apps/orchestrator && mix compile --warnings-as-errors && mix test`.
- Manual: post two messages as different `user_id`s — sharing one
  `session_key` per `RUNTIME-1` — to the same `(workspace, agent)`; confirm
  they resolve to a single `session_thread` row, (1) the loaded history
  includes both turns,
  (2) names resolve, and (3) the provider message array carries author info
  for each human turn. Confirm a single-author workspace's prompt is
  unchanged / clean.

## Non-goals

- Threading or branching within a conversation; `@`-mention routing to a
  specific member; per-member private sub-threads with the same agent.
- Changing message persistence — the schema already has `message.user_id`
  and a nullable `session_thread.user_id`; no migration is needed for this
  stream.
- Authorization. The runtime talks to Supabase with the service-role token
  and **trusts platform-side workspace scoping**; membership/RLS enforcement
  is the platform/harper-server `AUTHZ` workstream, not a runtime concern.

## Companion / cross-repo

- **parallel-agent-platform**:
  `docs/active/shared-conversation-speaker-identity-scope.md`
  (`CONVO-1/2/4`) and the
  [`shared-agents-overview-scope.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/shared-agents-overview-scope.md)
  umbrella.
