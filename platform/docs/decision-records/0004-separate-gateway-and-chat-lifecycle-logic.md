# DR 0004: Separate gateway lifecycle from chat state reduction

## Status

Proposed

## Context

Two frontend files currently own a large amount of runtime lifecycle behavior:

- `apps/web/src/context/GatewayContext.tsx`
- `apps/web/src/hooks/useChat.ts`

Together they cover:

- scope resolution,
- reconnect scheduling,
- readiness checks,
- websocket event subscription,
- broker history fetching,
- chat event reduction,
- optimistic UI updates,
- abort/send command wiring.

The code is still understandable, but the boundaries are transport-heavy and make future changes harder to stage safely.

## Decision

Keep the public provider and hook APIs stable, but extract internal lifecycle helpers so transport concerns and state transitions are less intertwined.

Expected boundaries:

- gateway reconnect/scope resolution helpers behind `GatewayContext`,
- broker chat history fetch helper behind `useChat`,
- chat event reduction helper that turns gateway payloads into state transitions.

The goal is not to introduce extra abstraction for its own sake. The goal is to make lifecycle behavior testable without rendering the full UI tree.

## Consequences

- Runtime connection behavior becomes easier to test in isolation.
- Chat state handling becomes less coupled to direct `fetch` and event-subscription code.
- Future changes such as additional chat states or reconnect policy changes will have clearer edit points.
- The team should avoid over-splitting into many tiny files; a small number of coherent helpers is enough.

## Next step

Start with `useChat`:

- extract `fetchChatHistory(...)`,
- extract `applyChatEvent(...)`,
- keep `sendMessage` and `abort` in the hook until those seams are stable.
