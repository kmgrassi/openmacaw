# Model-Agnostic Message Store — Platform Scoping

## Goal

Decouple message persistence from the transport layer and model provider so that
an agent's conversation history survives model switches, and every assistant
message records which model produced it.

Today messages flow through two separate paths:

1. **WebSocket gateway** — messages are persisted via the broker/runtime proxy
   (`POST /api/agents/:id/messages`, loaded from `ROUTES.agentMessages`).  The
   `useChat` hook reads them back with a `GET` keyed by `session_key`.
2. **Local model chat (dev proxy)** — messages are held in browser
   `localStorage`; nothing is persisted server-side.

Neither path stores structured model metadata (`model`, `provider`,
`runner_kind`) on individual messages in a way that is queryable or
transport-independent.

---

## Existing Schema (reference)

### `message` table (harper-server / Supabase)

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| workspace_id | text | required |
| agent_id | text | nullable |
| role | enum (role) | user / assistant / system |
| content | text | nullable |
| model | text | nullable — exists but sparsely populated |
| provider | text | nullable — exists but sparsely populated |
| session_id | text | FK -> session_thread.id |
| metadata | jsonb | default '{}' |
| created_at | timestamptz | |

### `session_thread` table

Contains `model` and `model_provider` columns, but those represent the
*session-level* model at time of creation — not per-message provenance.

### `broker_run` table

Tracks run lifecycle; does not carry per-message model info.

---

## PR Plan

### PR 1 — Unified Message API

**Branch:** `feat/unified-message-api`

Create a first-class REST surface for agent messages that writes directly to the
`message` table with full model metadata. The local chat persistence surface
must not reuse `/api/agents/:id/messages` until the existing structured
agent-control `POST` handler and runtime-proxied history `GET` handler are
folded into the same backward-compatible contract.

#### Endpoints

```
POST /api/agents/:agentId/messages             // existing control-message contract
POST /api/agents/:agentId/local-chat/messages
GET  /api/agents/:agentId/local-chat/messages?limit=
```

#### Write contract (request body)

```ts
interface WriteMessageRequest {
  role: "user" | "assistant" | "system";
  content: string;
  sessionId?: string;          // optional — links to session_thread
  model?: string;              // e.g. "claude-sonnet-4-20250514"
  provider?: string;           // e.g. "anthropic", "openai", "openai-compatible"
  runnerKind?: RunnerKind;     // e.g. "codex", "openclaw", "local_runtime"
  requestId?: string;          // idempotency / correlation
  metadata?: Record<string, unknown>;
}
```

#### Read contract (response item)

```ts
interface AgentMessage {
  id: string;
  agentId: string;
  workspaceId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  provider: string | null;
  runnerKind: string | null;
  sessionId: string | null;
  createdAt: string;           // ISO-8601
  metadata: Record<string, unknown>;
}
```

#### Implementation notes

- Route lives in `apps/api/src/routes/agent-messages.ts` (new file).
- Preserve the current `POST /api/agents/:id/messages` handler
  (`createStructuredAgentMessage`) and its
  `CreateAgentControlMessageRequestSchema` contract. That route is the
  existing agent-control entrypoint (`workspaceId`, `observerAgentId`, `body`,
  etc.) and is not replaced by `WriteMessageRequest`.
- Use `/local-chat/messages` for this PR so it does not shadow the existing
  `POST /api/agents/:id/messages` structured agent-control endpoint or
  `GET /api/agents/:id/messages` runtime history proxy. If the final
  implementation reuses `/messages`, it must content-negotiate or otherwise
  accept the existing control-message schema without breaking current callers
  and tests.
- Writes go to harper-server's `message` table via Supabase client.
- `runner_kind` stored inside `metadata` JSONB until a dedicated column is
  added by the harper-server migration PR.
- Existing runtime history reads keep `GET /api/agents/:id/messages` compatible
  with the current `session_key` query parameter until that client path is
  explicitly migrated.
- Add Zod schemas in `contracts/agent-messages.ts`.

#### Files touched

- `contracts/agent-messages.ts` (new)
- `apps/api/src/routes/agent-messages.ts` (new)
- `apps/web/src/components/dashboard/LocalModelChat.tsx` (read/write local
  chat history through the scoped persistence endpoint)

---

### PR 2 — Gateway / WebSocket path writes through unified API

**Branch:** `feat/gateway-unified-messages`

Update the WebSocket gateway event pipeline so that when a chat turn completes,
the final message is persisted through the unified message API (PR 1) with full
model metadata sourced from the execution profile.

#### Changes

- In the broker proxy layer that handles `chat.send` responses, extract
  `model`, `provider`, and `runnerKind` from the execution profile attached to
  the run.
- Call the unified write endpoint (or the shared service function directly)
  instead of relying on the runtime to persist messages.
- `GatewayContext.tsx` / `useChat.loadHistory` can remain unchanged in this PR
  only if PR 1 keeps `GET /api/agents/:id/messages` compatible with the current
  `session_key` query parameter. If PR 1 standardizes exclusively on
  `session_id`, update `useChat` in the same PR that changes the read contract.

#### Files touched

- `apps/api/src/routes/proxy.ts` (chat finalization path)
- `apps/api/src/services/execution-profile-resolver.ts` (expose model info
  lookup for message writes)

---

### PR 3 — Local model chat persistence

**Branch:** `feat/local-chat-persistence`

Replace `localStorage`-based message history for local model chat with the same
unified API used by the gateway path.

#### Changes

- After a local model response completes, `POST` the user message and assistant
  message to `/api/agents/:agentId/local-chat/messages` with
  `runner_kind: "local_runtime"` and the model/provider from the
  `LocalModelRegistrationResponse`.
- On load, fetch history from `GET /api/agents/:agentId/local-chat/messages`
  instead of reading `localStorage`.
- Remove `localStorage` message read/write code.

#### Files touched

- `apps/web/src/hooks/useChat.ts` (or dedicated local-chat hook if separated)
- `contracts/local-runtime.ts` (export model metadata shape for reuse)
- `apps/web/src/components/settings/AgentModelPolicy.tsx` (if it handles
  local chat display)

---

### PR 4 — Message history UI with model badges

**Branch:** `feat/message-model-badges`

Surface per-message model provenance in the chat UI.

#### Changes

- Extend `ChatMessage` type in `useChat.ts` to include `model`, `provider`,
  `runnerKind`.
- Update `normalizeMessages` to extract these fields from the API response.
- Render a small badge/chip on each assistant message showing the model name
  (e.g., "claude-sonnet-4-20250514 via anthropic").
- Badge color/icon varies by provider for quick visual scanning.

#### Files touched

- `apps/web/src/hooks/useChat.ts`
- `apps/web/src/components/chat/MessageBubble.tsx` (or equivalent)
- New component: `apps/web/src/components/chat/ModelBadge.tsx`

---

## Shared Contracts Summary

```ts
// contracts/agent-messages.ts

import { z } from "zod";
import { RUNNER_KINDS } from "./runner-kinds.js";

export const AgentMessageRoleSchema = z.enum(["user", "assistant", "system"]);

export const WriteMessageRequestSchema = z.object({
  role: AgentMessageRoleSchema,
  content: z.string().min(1),
  sessionId: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  runnerKind: z.enum(RUNNER_KINDS).optional(),
  requestId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const AgentMessageSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string(),
  workspaceId: z.string(),
  role: AgentMessageRoleSchema,
  content: z.string(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  runnerKind: z.string().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  metadata: z.record(z.unknown()),
});
```

---

## Open Questions

1. **Session continuity** — When a user switches models mid-conversation, should
   we start a new `session_thread` or continue the existing one?
   Recommendation: continue the same session; the `session_thread.model` column
   becomes the *initial* model, not an invariant.
2. **Migration of existing localStorage messages** — Do we need a one-time
   migration, or is it acceptable to start fresh?
3. **Rate limiting** — Should `POST /api/agents/:id/local-chat/messages` be
   rate-limited separately from chat sends?
