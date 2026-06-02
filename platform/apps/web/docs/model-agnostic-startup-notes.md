# Client Notes: Model-Agnostic Startup

## Context

Server/gateway are being refactored so startup/connect does not require provider readiness.

## Client behavior expectations

- Client should allow connect/session initialization even if provider credentials are absent.
- Provider/config errors should appear only after user sends a message (execution request).
- UI should distinguish:
  - `Not connected` (transport/auth/scope issue)
  - `Connected but run failed` (provider/model config issue)

## Suggested UI states

- Connection status: `connected` as soon as WS handshake and runtime scope succeed.
- Composer enabled when connected (unless policy forbids send).
- On run error:
  - show explicit code/message (`provider_not_configured_for_agent`, `model_not_configured`),
  - keep socket/session alive,
  - offer CTA to configure credentials/agent.

## Validation checklist

1. Connect succeeds with missing provider credentials.
2. First message returns deterministic run error (not disconnect loop).
3. After credentials are configured, next message succeeds without page refresh.
4. No hard dependency on model/provider readiness in initial app load.
