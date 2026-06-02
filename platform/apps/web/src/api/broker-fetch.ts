import { resolveBrokerBase } from "./broker";
import { clearAllSupabaseAuthStorage, getSupabaseAccessToken, getSupabaseClient } from "./supabase";

// Error codes the platform API returns when the presented bearer token is
// missing, malformed, expired, or signed for a different Supabase project.
// Any of these means the session in localStorage is not usable against this
// API — the user must re-authenticate.
const STALE_AUTH_ERROR_CODES = new Set([
  "invalid_token",
  "auth_required",
  "token_expired",
]);

export async function brokerFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  const requestHeaders = new Headers(init.headers);
  if (!requestHeaders.has("authorization")) {
    const accessToken = await getSupabaseAccessToken();
    requestHeaders.set("authorization", `Bearer ${accessToken}`);
  }

  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${resolveBrokerBase()}${pathOrUrl}`;
  const response = await fetch(url, {
    ...init,
    credentials: init.credentials ?? "include",
    headers: requestHeaders,
  });

  // If the API rejects our bearer as stale, proactively clear the local
  // session so the next render routes to /login instead of looping on the
  // same bad token. We don't navigate here — that's the store/router's
  // concern (they already react to Supabase auth state changes).
  if (response.status === 401) {
    await maybeClearStaleSession(response);
  }

  return response;
}

async function maybeClearStaleSession(response: Response): Promise<void> {
  try {
    // Clone so the caller can still read the original response body.
    const body = await response.clone().json();
    const code = body?.error?.code ?? body?.code;
    if (typeof code === "string" && STALE_AUTH_ERROR_CODES.has(code)) {
      await getSupabaseClient().auth.signOut({ scope: "local" });
      clearAllSupabaseAuthStorage();
    }
  } catch {
    // Body wasn't JSON or parsing blew up — a plain 401 with no
    // machine-readable code might be app-level ACL rather than stale auth.
    // Leave the session alone; the user sees the error and can re-login
    // manually if needed.
  }
}
