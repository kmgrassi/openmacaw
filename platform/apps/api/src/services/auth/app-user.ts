// ─────────────────────────────────────────────────────────────────────────
// auth.users.id  vs  public.user.id
// ─────────────────────────────────────────────────────────────────────────
// Supabase Auth issues JWTs whose `sub` claim is the row id in
// `auth.users`. That id is the SUPABASE-AUTH IDENTITY — it is the
// only thing the JWT proves you control, and it is what RLS sees as
// `auth.uid()`.
//
// The application has a separate identity table — `public.user` —
// with its OWN primary key (`public.user.id`) and a nullable link
// column (`public.user.auth_id`) pointing back to `auth.users.id`.
// All workspace / agent / credential rows are foreign-keyed to
// `public.user.id`, NOT to `auth.users.id`. They are the same value
// for a freshly self-signed-up user (the trigger defaults
// `id := new.id` when no preexisting public.user row matches by
// email) but they are DIFFERENT values for any user who was
// pre-created (invites, migrations, admin-provisioned accounts) and
// later linked to an auth identity via email match.
//
// The bug this module exists to prevent: API code that reads
// `req.userId` from the JWT-validated middleware and uses it as a
// `public.user.id`. That works for type-A users and 502s with a
// confusing FK-violation error for type-B users.
//
// The fix: every authenticated request resolves auth.users.id →
// public.user.id once, in `requireAuth`, and route handlers see the
// APP user id on `req.userId`. The original auth-user id is still
// available as `req.authUserId` for the rare cases that need it
// (e.g. logging, calling /auth/v1/* endpoints).
//
// If a future call site needs the public.user row itself (email,
// full_name, avatar_url, …), use `req.appUser`.
import type { Tables } from "@kmgrassi/supabase-schema";
import { executeSupabaseRows, getSupabaseForAccessToken } from "../../supabase-client.js";

export type AppUserRow = Tables<"user">;

/**
 * Resolve a Supabase auth user id to the corresponding `public.user`
 * row.
 *
 * Lookup precedence mirrors the SQL `current_app_user_id()` helper:
 *   1. `public.user.auth_id = <authUserId>` (the canonical link)
 *   2. `public.user.id = <authUserId>` (legacy rows that predate
 *      `auth_id` and self-signups whose `id` defaulted to the
 *      auth.users id)
 *
 * Returns `null` if neither lookup matches. Callers decide whether
 * that is a 401 (user is not provisioned in this app) or a fatal
 * 500.
 *
 * Uses the user's own access token so RLS scopes the query to rows
 * the user is allowed to see — no service-role escalation.
 */
export async function getAppUserByAuthId(accessToken: string, authUserId: string): Promise<AppUserRow | null> {
  const trimmedAuthId = authUserId.trim();
  if (!trimmedAuthId) return null;

  const APP_USER_SELECT = "id,auth_id,email,full_name,first_name,last_name,avatar_url,type" as const;

  // Try the canonical link first.
  const byAuthId = await executeSupabaseRows<AppUserRow>(
    "user query",
    getSupabaseForAccessToken(accessToken).from("user").select(APP_USER_SELECT).eq("auth_id", trimmedAuthId).limit(1),
  );

  if (byAuthId[0]) return byAuthId[0] as AppUserRow;

  // Legacy fallback: rows whose primary key equals the auth user id.
  // Restrict to rows where `auth_id` is null so we don't accidentally
  // match an unrelated user whose `id` happens to collide with a
  // different person's auth uuid (vanishingly unlikely with v4 uuids,
  // but the constraint is free).
  const byId = await executeSupabaseRows<AppUserRow>(
    "user query",
    getSupabaseForAccessToken(accessToken)
      .from("user")
      .select(APP_USER_SELECT)
      .eq("id", trimmedAuthId)
      .is("auth_id", null)
      .limit(1),
  );

  return (byId[0] as AppUserRow | undefined) ?? null;
}
