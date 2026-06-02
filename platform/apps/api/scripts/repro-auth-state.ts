// Reproduces /api/auth/state's downstream Supabase calls against the
// live database, using the service-role key as the "access token" so
// every query bypasses RLS. Anything that still throws at the SQL
// level (e.g. a dropped column the API code hasn't been updated for)
// will surface here without needing a real user JWT.
//
// Two modes:
//   --raw       call listSetupAuthState directly with the input id.
//               Useful to reproduce the FK-violation bug for users
//               whose public.user.id ≠ auth.users.id.
//   (default)   resolve auth.users.id → public.user.id first via the
//               same path requireAuth() now takes, then call
//               listSetupAuthState with the resolved id. Useful to
//               confirm the fix works.
//
// Usage:
//   tsx apps/api/scripts/repro-auth-state.ts <auth_user_id>
//   tsx apps/api/scripts/repro-auth-state.ts <auth_user_id> --raw
import "dotenv/config";

import { getAppUserByAuthId } from "../src/services/auth/app-user.js";
import { listSetupAuthState } from "../src/services/setup.js";

const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const authUserId = process.argv[2];
const raw = process.argv.includes("--raw");

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set");
  process.exit(2);
}
if (!authUserId) {
  console.error("usage: tsx apps/api/scripts/repro-auth-state.ts <auth_user_id> [--raw]");
  process.exit(2);
}

async function main() {
  let resolvedUserId = authUserId;

  if (!raw) {
    console.log(`[repro] resolving auth.users.id=${authUserId} → public.user.id …`);
    const appUser = await getAppUserByAuthId(SERVICE_ROLE_KEY, authUserId);
    if (!appUser) {
      console.error(`[repro] no public.user row found for auth_id=${authUserId}`);
      console.error(
        "[repro] this is the 'app_user_not_provisioned' case — the auth → public.user trigger may not have fired",
      );
      process.exit(3);
    }
    console.log(`[repro] resolved → public.user.id=${appUser.id} (email=${appUser.email ?? "?"})`);
    resolvedUserId = appUser.id;
  } else {
    console.log(`[repro] --raw: calling listSetupAuthState directly with auth.users.id=${authUserId}`);
  }

  console.log(`[repro] calling listSetupAuthState(user_id=${resolvedUserId})`);
  try {
    const state = await listSetupAuthState(SERVICE_ROLE_KEY, resolvedUserId);
    console.log(`[repro] OK — listSetupAuthState returned ${state.workspaces.length} workspace(s)`);
    process.exit(0);
  } catch (error) {
    console.error("[repro] THREW:");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}

void main();
