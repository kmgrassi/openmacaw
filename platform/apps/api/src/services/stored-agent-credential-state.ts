import type { SavedCredential } from "../../../../contracts/credentials.js";
import { SavedCredentialListResponseSchema } from "../../../../contracts/credentials.js";
import { ApiRouteError } from "../http.js";
import type { CredentialAliasProjection } from "../repositories/credentials.js";
import { listCredentialAliases } from "../repositories/credentials.js";
import { listSavedModelProviderCredentialsForWorkspaceFromSupabase } from "./saved-credentials.js";

export function sanitizedCredential(credential: SavedCredential) {
  const sanitized = SavedCredentialListResponseSchema.parse({ credentials: [credential] }).credentials[0];
  if (!sanitized) {
    throw new ApiRouteError(502, "credential_sanitize_failed", "Stored credential sanitizer returned no credential");
  }
  return sanitized;
}

export function credentialProviderForRow(credential: SavedCredential | null | undefined): string | null {
  return typeof credential?.provider === "string" && credential.provider.trim().length > 0
    ? credential.provider.trim()
    : null;
}

export function credentialRowId(credential: SavedCredential): string {
  return credential.credentialRowId ?? credential.id.split(":", 1)[0] ?? credential.id;
}

export function buildCredentialByRowId(credentials: SavedCredential[]) {
  const byRowId = new Map<string, SavedCredential>();
  for (const credential of credentials) {
    byRowId.set(credentialRowId(credential), sanitizedCredential(credential));
  }
  return byRowId;
}

export function aliasResponse(alias: CredentialAliasProjection, credentialByRowId: Map<string, SavedCredential>) {
  return {
    workspaceId: alias.workspace_id,
    alias: alias.alias,
    credentialId: alias.credential_id,
    createdAt: alias.created_at,
    updatedAt: alias.created_at,
    credential: credentialByRowId.get(alias.credential_id) ?? null,
  };
}

export async function listWorkspaceCredentialReferenceState(workspaceId: string, userId?: string | null) {
  const [credentials, aliases] = await Promise.all([
    listSavedModelProviderCredentialsForWorkspaceFromSupabase(workspaceId, userId),
    listCredentialAliases(workspaceId),
  ]);
  const sanitized = credentials.map(sanitizedCredential);
  const credentialByRowId = buildCredentialByRowId(sanitized);
  return {
    credentials: sanitized,
    aliases: aliases.map((alias) => aliasResponse(alias, credentialByRowId)),
    credentialByRowId,
  };
}
