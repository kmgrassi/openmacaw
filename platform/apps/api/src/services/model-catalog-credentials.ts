import {
  listSavedCredentialsForAgentFromSupabase,
  listSavedModelProviderCredentialsForWorkspaceFromSupabase,
} from "./saved-credentials.js";
import { adapterByProvider, modelProviderAdapters } from "./model-catalog-providers.js";
import type { CredentialLookupResult, ProviderAdapter, ProviderCredential } from "./model-catalog-types.js";
import { resolveStoredCredentialSecret } from "./stored-credentials.js";
import type { ModelProvider } from "../../../../contracts/model-catalog.js";

export function findEnvCredential(adapter: ProviderAdapter): ProviderCredential | null {
  for (const envVar of adapter.envVars) {
    const value = process.env[envVar]?.trim();
    if (value) return { value, sourceKey: `env:${envVar}` };
  }
  return null;
}

export async function loadAgentCredentials(
  agentId: string | null | undefined,
  workspaceId: string | null | undefined,
): Promise<CredentialLookupResult> {
  const result: CredentialLookupResult = { credentials: new Map(), errors: [] };
  if (!agentId || !workspaceId) return result;

  try {
    const credentials = await listSavedCredentialsForAgentFromSupabase(agentId, workspaceId);
    await Promise.all(
      credentials.map(async (credential) => {
        if (credential.provider !== "openai" && credential.provider !== "anthropic") return;
        const value = await resolveStoredCredentialSecret(credential);
        if (value) {
          result.credentials.set(credential.provider, {
            value,
            sourceKey: `agent:${workspaceId}:${agentId}`,
            endpoint: credential.endpoint,
            apiVersion: credential.apiVersion,
          });
        }
      }),
    );
  } catch (error) {
    result.errors.push({
      provider: "openai",
      code: "credential_lookup_failed",
      message: String(error),
    });
    result.errors.push({
      provider: "anthropic",
      code: "credential_lookup_failed",
      message: String(error),
    });
  }

  return result;
}

export async function loadWorkspaceCredentials(
  workspaceId: string | null | undefined,
  userId: string | null | undefined,
): Promise<CredentialLookupResult> {
  const result: CredentialLookupResult = { credentials: new Map(), errors: [] };
  if (!workspaceId) return result;

  try {
    const credentials = await listSavedModelProviderCredentialsForWorkspaceFromSupabase(workspaceId, userId);
    await Promise.all(
      credentials.map(async (credential) => {
        const parsedProvider = typeof credential.provider === "string" ? (credential.provider as ModelProvider) : null;
        if (!parsedProvider || !adapterByProvider.has(parsedProvider)) return;
        const value = await resolveStoredCredentialSecret(credential);
        if (value) {
          result.credentials.set(parsedProvider, {
            value,
            sourceKey: `workspace:${workspaceId}:${userId ?? "workspace"}`,
            endpoint: credential.endpoint,
            apiVersion: credential.apiVersion,
          });
        }
      }),
    );
  } catch (error) {
    for (const adapter of modelProviderAdapters) {
      result.errors.push({
        provider: adapter.provider,
        code: "credential_lookup_failed",
        message: String(error),
      });
    }
  }

  return result;
}
