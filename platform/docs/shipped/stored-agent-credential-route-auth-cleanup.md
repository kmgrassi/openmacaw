# Stored Agent Credential Route Auth Cleanup

Status: active scoping. Created 2026-05-22.

## Problem

`apps/api/src/routes/stored-agent-credentials.ts` had drifted away from the
standard authenticated route pattern:

- Only `ensure-default-routing` used `apiRoute({ requireAuth: true, ... })`.
- The credential list, credential-reference, save, launch, and activate
  endpoints were still handwritten Express handlers.
- Those handlers read `req.userId` directly and, in some cases, behaved like
  authenticated routes without declaring that contract at the HTTP boundary.
- Launch/activate requests validated response payloads but not the request
  body shape up front.

That combination makes the file ambiguous to maintain: route auth invariants
are implicit, body validation is inconsistent, and new handlers are more likely
to copy the older style.

## Scope

One cleanup PR should:

1. Move the stored-agent credential endpoints onto `apiRoute` with
   `requireAuth: true`.
2. Replace `req.userId` / `accessToken ?? ""` fallback patterns with the
   authenticated context supplied by `apiRoute`.
3. Add shared request schemas for stored-credential launch and stored-agent
   activation in `contracts/credentials.ts`.
4. Add route tests that prove the previously unguarded endpoints now reject
   unauthenticated requests and that the new launch schema is enforced.

## Non-Goals

- Changing the response payloads for stored-agent credential flows.
- Changing launch semantics, planning handoff semantics, or runtime behavior.
- Refactoring unrelated credential routes outside the stored-agent surface.

## Validation

- `pnpm -C apps/api run validate`
- `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`
- Dev-server smoke:
  `curl -i 'http://127.0.0.1:<api-port>/api/stored-agents/<agent-id>/credentials?workspaceId=<workspace-id>'`
  without auth should return `401 auth_required`, and `.run-logs/api.log`
  should show the request as an authenticated-route failure rather than a
  downstream service error.
