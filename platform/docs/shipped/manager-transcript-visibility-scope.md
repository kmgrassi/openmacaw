# Manager Transcript Interaction Scope

## Goal

Let the manager agent be chatted with in the same UI path as regular agents,
while also showing autonomous manager check-ins in the same transcript once the
runtime persists them to the shared message store.

Runtime companion scope:

- `parallel-agent-runtime` PR #214:
  `docs/manager-message-persistence-scope.md`

The Platform work should not create a separate manager transcript system. It
should read and write manager messages through the same durable
`session_thread` / `message` path used by regular agents.

## Current State

The manager agent can be configured and monitored from Platform settings, but
today the UI special-cases manager agents as read-only and the scheduler turns
are not surfaced as part of the normal chat experience.

Relevant Platform surfaces:

- `apps/web/src/components/settings/ManagerAgentSection.tsx`
- `apps/web/src/components/settings/SessionsSection.tsx`
- dashboard chat/session components
- Supabase-backed session/message read paths
- manager runtime status API and contracts

The runtime follow-up will write autonomous manager ticks as normal message rows
with metadata such as:

```json
{
  "source": "manager_scheduler",
  "kind": "due_tasks",
  "work_item_ids": ["..."],
  "tool_calls": []
}
```

Platform needs to make sure those rows are discoverable and understandable.

## Design Principle

Manager transcript interaction is a read/display plus UI-routing problem in
Platform.

Do not add a manager-only API unless the shared message/session query path
cannot represent the data. Manager messages should be differentiated by
`agent.type === "manager"` and message metadata, not by a separate storage
model.

## Proposed Platform Design

### 1. Verify manager sessions are not filtered out

Audit all session/message queries and UI filters for assumptions like:

- hide `agentType === "manager"`
- only list planning/coding agents
- only show sessions created through websocket chat
- only show sessions with human-originated `chat.send` runs

If manager sessions are filtered out, update the filters so manager-agent
threads appear when the selected workspace includes a manager agent.

### 2. Make the manager chat surface interactive

`ManagerAgentSection` and the dashboard chat view should allow normal chat
interaction with the manager agent.

Recommended MVP:

- remove the manager-only `readOnly` special casing in the web app
- keep the existing manager session/thread routing, but allow `chat.send`
  from the manager chat view
- keep Live Status focused on health/cadence; do not overload it with full chat
  history

### 3. Render autonomous manager messages cleanly

Manager scheduler input messages may contain the raw due-task JSON payload:

```json
{"due_tasks":[...]}
```

The UI should avoid dumping a huge JSON blob as the only visible content.

Recommended display:

- show a compact "Manager checked N due tasks" style summary when metadata
  contains `source: manager_scheduler` and `kind: due_tasks`
- show linked/identified work item ids when present
- keep raw JSON available in a details/disclosure area for debugging
- show assistant output as normal assistant text
- show tool calls from metadata as compact status rows or chips

### 4. Preserve existing message history behavior

Manager transcript support should reuse existing loading, pagination, and
session selection behavior.

Do not introduce a manager-only polling loop or a separate transcript reader
unless the current session/message refresh model cannot show newly inserted
manager rows. If a refresh is needed, prefer reusing the existing
session/message invalidation mechanism.

### 5. RLS and authorization check

Confirm authenticated workspace users can read manager-agent messages through
the existing RLS policies.

Runtime manager messages should use `user_id: null` because an autonomous
manager tick is not owned by an active browser user. If RLS is scoped by
`message.user_id`, manager autonomous messages will need policy adjustment.
Preferred read authorization should be workspace membership, not message author
equality.

## Implementation Plan

### PR 1: Make manager chat interactive

Likely files:

- `apps/web/src/components/Layout.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/settings/ManagerAgentSection.tsx`
- session/message API helpers under `apps/web/src/api`
- relevant chat routing tests

Expected changes:

- remove manager read-only special casing
- route manager selection through the same composer and send path used by other
  agents
- keep manager session/thread routing compatible with the normal chat surface
- add tests proving manager chat can send and receive messages

### PR 2: Render and surface manager transcript rows

Likely files:

- chat message components
- session detail components
- message metadata formatting helpers
- session list visibility tests

Expected changes:

- ensure manager `session_thread` rows can appear in session lists
- summarize `manager_scheduler` due-task input messages
- display work item ids and tool-call metadata
- keep raw payload inspectable for debugging
- add tests or fixtures proving manager transcript rows are visible and
  understandable

### PR 3: Authorization/policy follow-up if needed

Only needed if runtime-written manager messages are not readable by workspace
members through existing policies.

Expected changes:

- update Supabase RLS policy to allow workspace-member reads for manager
  messages
- regenerate schema/types if a migration is required
- add API/read tests covering manager message visibility

## Acceptance Criteria

- A workspace user can chat with the manager agent through the normal chat
  composer.
- Manager sessions are not hidden solely because the agent type is `manager`.
- Manager scheduler input messages are summarized rather than displayed only as
  raw JSON.
- Assistant responses from manager turns render in the same chat UI as regular
  assistant messages.
- Manager check-ins and replies are persisted as regular `message` rows with
  metadata, not as a separate manager-only transcript model.
- Tool-call and due-work-item metadata are visible enough for debugging.
- Existing planning/coding chat history behavior is unchanged.

## Non-Goals

- implementing runtime message persistence
- creating a separate manager transcript table
- changing manager cadence or due-task selection
- live-streaming manager turns into every connected browser
- redesigning the whole chat UI

## Open Questions

1. Should manager transcript navigation live only in Settings, or also in the
   dashboard sidebar?
2. Should manager due-task input messages be visible by default, or collapsed by
   default?
3. Should manager tool calls become timeline rows in the UI, or remain metadata
   on the assistant message for the first pass?
4. Should the manager transcript be one long-lived thread per workspace manager
   or grouped by date/run in the UI?
