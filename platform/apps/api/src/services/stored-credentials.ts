import { resolveSecretReference } from "../secrets.js";
import { updateCredentialKeyValue, updateCredentialValidationState } from "../repositories/credentials.js";
import { refreshOpenAICodexToken, type OpenAICodexOAuthTokens } from "./oauth/openai-codex.js";

/**
 * Refresh a few seconds before actual expiry. The OpenAI access_token
 * lifetime is ~1 hour; refreshing slightly early avoids the worker booting
 * with a token that will expire mid-call.
 */
const OAUTH_REFRESH_THRESHOLD_MS = 60_000;

type ResolvableCredential = {
  secretValue: string;
  secretRef: string | null;
  aliases: string[];
  provider?: string | null;
  credentialRowId?: string;
  oauth?: {
    refreshToken: string;
    expiresAt: number | null;
  } | null;
};

export async function resolveStoredCredentialSecret(credential: ResolvableCredential): Promise<string | null> {
  if (credential.provider === "openai_codex" && credential.oauth) {
    return await resolveOpenAICodexAccessToken(credential);
  }
  return (
    credential.secretValue ||
    (credential.secretRef ? await resolveSecretReference(credential.secretRef, credential.aliases) : null)
  );
}

async function resolveOpenAICodexAccessToken(credential: ResolvableCredential): Promise<string | null> {
  const oauth = credential.oauth;
  if (!oauth) return credential.secretValue || null;

  const expiresAt = oauth.expiresAt ?? 0;
  const isExpiring = expiresAt - Date.now() <= OAUTH_REFRESH_THRESHOLD_MS;
  if (!isExpiring && credential.secretValue) {
    return credential.secretValue;
  }

  let refreshed: OpenAICodexOAuthTokens;
  try {
    refreshed = await refreshOpenAICodexToken(oauth.refreshToken);
  } catch (error) {
    if (credential.credentialRowId) {
      await updateCredentialValidationState({
        credentialId: credential.credentialRowId,
        validationState: "expired",
        validatedAt: new Date().toISOString(),
      });
    }
    throw error;
  }

  if (credential.credentialRowId) {
    await persistRefreshedTokens(credential.credentialRowId, refreshed);
  }
  return refreshed.access;
}

async function persistRefreshedTokens(credentialRowId: string, tokens: OpenAICodexOAuthTokens): Promise<void> {
  const { getServiceRoleSupabase, normalizeSupabaseError } = await import("../supabase-client.js");
  const { data, error } = await getServiceRoleSupabase()
    .from("credential")
    .select("key_value")
    .eq("id", credentialRowId)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("credential select for refresh", error);
  const existing =
    data?.key_value && typeof data.key_value === "object" && !Array.isArray(data.key_value)
      ? (data.key_value as Record<string, unknown>)
      : {};
  await updateCredentialKeyValue({
    credentialId: credentialRowId,
    keyValue: {
      ...existing,
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_at: tokens.expires,
      key_last4: tokens.access.slice(-4),
    },
    updatedAt: new Date().toISOString(),
    validationState: "ok",
    validatedAt: new Date().toISOString(),
  });
}
