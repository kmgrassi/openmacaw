# Auth — Supabase JWT Validation (Option B)

How the web client's identity flows from the browser through the platform API
server to the runtime (orchestrator / launcher / runtime `/ws`). This doc
picks the design; a follow-up PR in each repo implements its half.

> **Mirrored.** This same design doc also lives in the runtime repo at
> [`docs/auth-jwt-design.md`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/auth-jwt-design.md).
> The two copies are kept identical so anyone working in either repo can read
> the full design without jumping across repos. If you edit one, edit the
> other in the same PR.

---

## Architectural rule (reminder)

All client → data calls go through the **platform REST API**. The browser
does not import `supabase-js` for reads or writes. The platform API is the
single auth boundary: it verifies user JWTs, enforces authorization in app
code, and talks to Supabase (usually with the service role).

This doc operationalizes that rule for authentication — specifically, how
the Supabase-issued user JWT is verified and how the resulting identity
propagates to the runtime.

## Current state

Nothing verifies a Supabase JWT server-side in either repo today.

### Platform API (TypeScript/Node)
- Browser already sends `Authorization: Bearer <supabase_access_token>` —
  see `apps/web/src/api/broker.ts`.
- Server extracts the Bearer token with regex in
  `apps/api/src/http.ts` but **does not verify its signature**. It forwards
  to Supabase PostgREST / Auth and lets RLS enforce. No reusable middleware
  exists.

### Runtime (Elixir)
- `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex` reads only
  `agent_id` and `workspace_id` from the WS query params. No user identity
  threads through at all.

### Reference: Harper-Server
Reviewed `/src/middleware/centralAuthMiddleware.ts`. Pattern:

- Uses `jsonwebtoken` (Node lib) + `crypto.createPublicKey()`.
- Asymmetric: **RS256** with JWKS; not HS256 with a shared secret.
- Extracts Bearer → reads JWT header `kid` → loads matching public key →
  `jwt.verify(token, key, { algorithms: ['RS256'], audience, issuer })`.
- Pulls `sub` as user id, attaches `req.userId` + `req.auth` on the request.
- **No round-trip to Supabase Auth** — claims are trusted once the signature
  verifies.

That's the pattern we copy on the platform side.

> **`req.userId` is NOT the JWT `sub`.** That document predates the
> auth.users.id vs. public.user.id split. Today, `requireAuth` resolves
> the JWT `sub` (`auth.users.id`) to the matching `public.user.id` and
> sets `req.userId` to the latter, because every `_user_id` FK in the
> schema points at `public.user.id`. The original JWT `sub` is
> available as `req.authUserId` if a handler genuinely needs it.
>
> See **[`docs/auth-user-vs-app-user.md`](./auth-user-vs-app-user.md)**
> for the full model and the resolver contract.

---

## Chosen design: Option B — platform validates, runtime trusts

```
                       Option B (chosen)
  browser ── Bearer JWT ─► platform API ── ?user_id=… ─► runtime
                           ↑                              ↑
                           verify JWT                     trust query param
                           (RS256 + JWKS)                 (network-isolated)
```

- The **JWT never reaches the runtime.** It stops at the platform.
- The platform strips it and appends the verified `user_id` to the upstream
  URL (for WS) or passes it into the proxy request body/context (for HTTP).
- The runtime reads `user_id` from its connection scope and persists it on
  every write (messages, session threads, broker_run telemetry, etc.).

### Why not the alternatives

|  | Option A — end-to-end JWT | **Option B — platform validates** | Option C — platform issues internal token |
|---|---|---|---|
| Runtime needs Elixir JWT lib | yes | **no** | yes |
| Safe if runtime is internet-exposed | yes | **no** | yes |
| Code volume | 2x | **1x** | 2x + key rotation |
| JWT leaks in runtime logs | possible | **no** | internal-only |

Option B wins for the current architecture because the **runtime is not
internet-exposed** — only the platform is. We commit to keeping it that way
(see Decision §3 below).

## Decisions locked in

| Decision | Choice | Rationale |
|---|---|---|
| Algorithm | **RS256** only (allowlist) | Supabase signs with RS256; asymmetric simplifies key rotation |
| Key source | **JWKS** at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached in memory, refreshed on `kid` miss | Matches Supabase's own guidance |
| Round-trip to Supabase Auth | **No** | Trust verified claims; adds latency + failure surface otherwise |
| Claims captured | `sub` → `user_id` (required). Also capture `email`, `role` for logging. Validate `exp`, `aud`, `iss`. | `aud` for Supabase is `"authenticated"`; `iss` is `${SUPABASE_URL}/auth/v1` |
| Runtime binding | **Not internet-exposed.** Loopback in dev; private subnet / internal ALB in prod. | Core safety assumption of Option B |
| Where the platform middleware lives | Register early in Express chain so every `/api/*` route gets `req.userId` for free | Reusable, one place to change |
| Who verifies on the WS handshake | The platform's WS proxy `upgrade` handler (same verifier the HTTP middleware uses) | Reuses the same function in both transports |
| Runtime trust model | Rejects WS connect if `user_id` query param is absent | Fails closed; makes the platform-required contract explicit |

## Open decisions

### 1. How does the browser send the JWT on the WS handshake?

Browsers cannot set custom headers on `new WebSocket()`. Three options:

- **(a) `Sec-WebSocket-Protocol` subprotocol** — `new WebSocket(url, ['bearer.'+token])`. This is what Supabase Realtime's own client does.
- **(b) Short-lived handshake token** — browser first POSTs to
  `/api/auth/ws-token` (authenticated via HTTP middleware), gets a single-use
  15-second token, then opens `ws://…/ws?ws_token=<token>`. The platform
  validates and exchanges it for `user_id` before upstreaming.
- **(c) Query-param JWT** — simplest; worst for logs (referrer, access logs
  all leak the token). Discard.

**Recommendation:** (a) subprotocol. It's what the ecosystem does, one round
trip, no extra endpoint. Fallback to (b) if anything in our proxy stack
strips subprotocols.

### 2. JWKS refresh cadence

- Load at platform boot, cache in memory.
- Refresh on `kid` miss during verification.
- No periodic timer. Supabase rotates rarely; on-miss refresh is adequate.

### 3. Is the runtime actually isolated today?

Needs confirmation per environment. Local dev: launcher binds to
`0.0.0.0:4100` currently — should change to `127.0.0.1:4100` for Option B to
hold. Prod: depends on ECS listener config (see
`apps/orchestrator/deploy/terraform/main.tf`); confirm the launcher is not
on a public-facing listener.

If we can't guarantee isolation, we fall back to Option A and make the
runtime verify JWTs too. That's a bigger PR — a port of Harper's pattern to
Elixir (`joken` + JWKS).

---

## Implementation — platform API server (`parallel-agent-platform`)

One PR. Title suggestion: `Add Supabase JWT auth middleware + WS proxy handshake`.

- [ ] Add `jsonwebtoken` + `jwks-rsa` (or equivalent JWKS cache) deps.
- [ ] `apps/api/src/middleware/authJwt.ts` — port Harper's
      `centralAuthMiddleware`. Export two entry points:
      - `verifyBearerToken(token: string): Promise<{userId: string, email?: string, role?: string}>` — pure function, reusable from both HTTP and WS paths.
      - `requireAuth(req, res, next)` — Express middleware that pulls the
        Bearer header, calls `verifyBearerToken`, attaches `req.userId`, or
        returns 401.
- [ ] Register `requireAuth` in `apps/api/src/app.ts` before route handlers
      so every `/api/*` gets `req.userId` by default. Explicitly skip only
      health checks.
- [ ] `apps/api/src/ws/orchestrator-proxy.ts` upgrade handler: extract JWT
      from the `Sec-WebSocket-Protocol` subprotocol, call
      `verifyBearerToken`, append `&user_id=<uuid>` to the upstream URL.
      Reject upgrade on missing/invalid token.
- [ ] Env vars: `SUPABASE_URL` (already present), no JWT secret needed
      (JWKS endpoint is public).
- [ ] Unit tests covering: valid RS256 token → success, expired token →
      401, wrong `aud` → 401, wrong `iss` → 401, unknown `kid` → JWKS
      refresh → success, non-RS256 alg → 401.
- [ ] Integration test: open a WS with a valid subprotocol-bearer token,
      confirm upstream URL carries `user_id`; open one without, confirm 401.

## Implementation — runtime (`parallel-agent-runtime`)

One PR (can land in parallel with platform). Title suggestion: `Add user_id to WS gateway scope`.

- [ ] Extend `scope_from_query/1` in
      [`gateway_socket.ex`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex#L36)
      to read `user_id` from query params. Reject the connect with a
      `runtime_scope_required` error if absent.
- [ ] Widen
      [`SessionStore`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/lib/symphony_elixir/gateway/session_store.ex#L8)
      scope type from `{agent_id, workspace_id, session_key}` to
      `{agent_id, workspace_id, session_key, user_id}`. Thread through
      `ensure_session`, `append_user_message`, `start_run`, etc.
- [ ] Bind the launcher/runtime HTTP server to **`127.0.0.1`** by default in
      local dev. Add an env var override for ECS if we use `0.0.0.0` on a
      private interface.
- [ ] Snapshot test: connect without `user_id` → 401-equivalent error
      frame. Connect with → accepted. No JWT library on the Elixir side —
      this is pure query-param plumbing.
- [ ] Update
      [`runtime_websocket_gateway_contract.md`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/runtime_websocket_gateway_contract.md)
      to document `user_id` as a required scope param.

## Non-goals

- Runtime does not verify JWTs. If the runtime ever needs to be exposed
  directly (e.g. a partner integration), switch to Option A — see §Why not.
- We don't introduce a second JWT issuer (no internal signed token — that's
  Option C).
- We don't implement user-level rate limiting or session revocation here.
- We don't add RLS as the primary enforcement mechanism — RLS remains
  defense-in-depth behind the platform's app-level authz.

## Dependencies / ordering

- The OR-7 chat-message persistence PR ([parallel-agent-runtime#53](https://github.com/kmgrassi/parallel-agent-runtime/pull/53)) already requires `user_id` in the WS scope. Land the runtime side of this auth work first, then OR-7 can rely on `user_id` being present. Or land them together.
- No Supabase schema changes. Uses only existing `message.user_id`, `session_thread.user_id`, `auth.users.id`.
