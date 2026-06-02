# Auth user id vs. app user id

**TL;DR:** A Supabase access token's `sub` claim is **`auth.users.id`** —
the supabase-auth identity. Every workspace / agent / credential FK in
`public.*` references **`public.user.id`** — the app user identity. They
are not interchangeable. Confusing them produces foreign-key violation
502s for any user whose two ids differ.

## The two ids

```
                ┌──────────────────────────┐
JWT (Bearer)──▶ │ auth.users.id            │  ← Supabase-auth identity. The only
                │                          │    thing the JWT proves you control.
                │ "sub" claim, auth.uid()  │    What RLS sees as auth.uid().
                └──────────┬───────────────┘
                           │ public.user.auth_id
                           ▼
                ┌──────────────────────────┐
                │ public.user.id           │  ← App user identity. PK of every
                │                          │    workspace / agent / credential
                │ FK target everywhere     │    foreign key.
                └──────────────────────────┘
```

When a new auth user signs up, the `handle_new_user` trigger on
`auth.users` runs (defined in
`harper-server/.../20260317173000_fix_auth_id_rls_mapping.sql`) and
chooses one of two paths:

1. **No matching email in `public.user`** — insert a fresh row with
   `id := new.id` and `auth_id := new.id`. The two ids are equal.
2. **A matching `public.user` row exists** (invited / migrated /
   admin-provisioned account) — update that row to set `auth_id :=
   new.id`. The original `id` is preserved. **The two ids are
   different.**

Path (1) is the common case for self-signups. Path (2) is the case that
breaks code that conflates the two ids — and is why the `/api/auth/state`
502 in production only hit some users, not all.

## How to tell which one a value is

| Source | Identity it carries | When in doubt |
| --- | --- | --- |
| `req.auth?.userId` (legacy) | auth.users.id | check `auth_id` in db |
| `req.authUserId` | auth.users.id | the JWT `sub` |
| `req.userId` | **public.user.id** | the FK target |
| `req.appUser` | full `public.user` row | use for email/name/avatar |
| JWT `sub` claim | auth.users.id | always |
| `auth.uid()` in SQL / RLS | auth.users.id | always |
| `public.current_app_user_id()` SQL | public.user.id | RLS uses this |
| Anything `_user_id` in `public.*` | public.user.id | always FK to `public.user` |

## The contract for new code

1. **Express handlers**: read `req.userId`. It is the
   **`public.user.id`**, resolved by `requireAuth` middleware. Use it
   anywhere a `_user_id` column expects a value.
2. **`req.authUserId` is rarely needed**. Only reach for it if you are
   making an outbound call to `/auth/v1/*` or logging the auth identity
   for traceability.
3. **`req.appUser`** gives you the full `public.user` row without an
   extra round-trip. Use it to grab `email`, `full_name`, `avatar_url`,
   etc. without re-querying.
4. **WebSocket handlers** that bypass Express middleware must call
   `getAppUserByAuthId(accessToken, auth.userId)` themselves before
   forwarding any `user_id` to the runtime. The orchestrator-proxy is
   the canonical example.
5. **Outbound calls to the runtime** must use the public.user.id. The
   runtime persists `user_id` to tables that FK into `public.user`, so a
   raw `auth.users.id` from the JWT will silently break for the type-2
   user case described above.

## How to ship a fix

The resolver lives in
`apps/api/src/services/auth/app-user.ts#getAppUserByAuthId`. Its
two-step lookup mirrors the SQL `current_app_user_id()` helper:

1. `public.user.auth_id = <auth.users.id>` (canonical link)
2. `public.user.id = <auth.users.id>` AND `auth_id IS NULL` (legacy
   fallback for rows that predate the `auth_id` column)

Returns `null` when neither lookup finds a row. Callers should turn that
into a 401 with code `app_user_not_provisioned` so the failure mode is
loud and obvious in logs — "this auth user has no `public.user` row" is
a real (rare) condition that means the `handle_new_user` trigger did
not fire for them and a human needs to either rerun the trigger or fill
the row in by hand.

## Common smells when reading code

The presence of any of these next to a `_user_id` write or filter is a
strong signal something is using the wrong identity:

- `userId: auth.userId` outside of `requireAuth` itself
- `requestUrl.searchParams.set("user_id", auth.userId)`
- `body: { user_id: req.auth.userId }`
- `accessToken` being plumbed alongside a string named `verifiedUserId`
  whose only validation is "is non-empty" (it should also be "was
  resolved through `getAppUserByAuthId`")

The fix in those cases is always: replace `auth.userId` /
`req.auth.userId` with `req.userId`, or call the resolver first if
the code path doesn't go through `requireAuth`.

## Related docs

- `docs/auth-jwt-design.md` — JWT verification design (the layer that
  produces `auth.userId`).
- `harper-server/supabase/migrations/20260317173000_fix_auth_id_rls_mapping.sql`
  — defines `current_app_user_id()` and `handle_new_user`.
