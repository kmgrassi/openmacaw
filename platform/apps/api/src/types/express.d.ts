import type { VerifiedAuth } from "../middleware/authJwt.js";
import type { AppUserRow } from "../services/auth/app-user.js";

declare global {
  namespace Express {
    interface Request {
      auth?: VerifiedAuth;

      // The APP user id (`public.user.id`). Set by `requireAuth`
      // after resolving auth.users.id → public.user.id. This is the
      // value FK columns across the schema reference
      // (workspaces.owner_user_id, agent.created_by_user_id,
      // workspace_members.user_id, …). Route handlers should use
      // this.
      userId?: string;

      // The SUPABASE-AUTH user id (the JWT `sub`,
      // `auth.users.id`). Distinct from `userId` for users whose
      // `public.user` row was created before they signed in (e.g.
      // invited users). Mostly only useful for logging or for
      // calling `/auth/v1/*` endpoints; route handlers should
      // prefer `userId`.
      authUserId?: string;

      // The full `public.user` row resolved from the auth
      // identity. Use when a handler needs email/full_name/avatar
      // without a second round-trip.
      appUser?: AppUserRow;

      requestId?: string;
      traceId?: string;
    }
  }
}

export {};
