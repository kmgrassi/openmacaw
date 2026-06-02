import type { Json } from "@kmgrassi/supabase-schema";
import { asRecord } from "../../../../contracts/agent-helpers.js";
import {
  CREDENTIAL_PROVIDERS,
  type ApiKeyCredentialProvider,
  credentialRecordMatchesProvider,
  detectInlineCredentialSecret,
  getCredentialProviderMetadata,
  normalizeCredentialProvider,
  maskCredentialLabel,
  type CredentialProvider,
  SavedCredentialSchema,
  type SavedCredential,
} from "../../../../contracts/credentials.js";
import {
  createAgentCredential,
  createWorkspaceModelProviderCredential,
  listAgentCredentialRows,
  listWorkspaceModelProviderCredentialRows,
  updateCredentialKeyValue,
  type CredentialProjection,
  type CredentialRow,
} from "../repositories/credentials.js";

type JsonObject = { [key: string]: Json | undefined };

type OAuthFields = {
  refreshToken: string;
  expiresAt: number | null;
};

export type ResolvedSavedCredential = SavedCredential & {
  secretValue: string;
  secretRef: string | null;
  aliases: string[];
  endpoint: string | null;
  apiVersion: string | null;
  oauth: OAuthFields | null;
};

function readNumber(value: Json | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function readOAuthFields(raw: JsonObject, provider: string | null): OAuthFields | null {
  if (provider !== "openai_codex") return null;
  const refreshToken =
    typeof raw.refresh_token === "string" && raw.refresh_token.trim().length > 0 ? raw.refresh_token.trim() : null;
  if (!refreshToken) return null;
  return {
    refreshToken,
    expiresAt: readNumber(raw.expires_at),
  };
}

function asJsonObject(value: Json | null): JsonObject | null {
  return asRecord(value) as JsonObject | null;
}

function requireApiKeyCredentialProvider(provider: CredentialProvider): ApiKeyCredentialProvider {
  if (provider === "openai_codex") {
    throw new Error("ChatGPT OAuth credentials cannot be saved as API keys");
  }
  return provider;
}

export function toSavedCredentials(row: CredentialProjection): ResolvedSavedCredential[] {
  const raw = asJsonObject(row.key_value);
  if (!raw) return [];

  const provider = normalizeCredentialProvider(row.provider);
  if (!provider) return [];

  const keyLast4 = typeof raw.key_last4 === "string" && raw.key_last4.trim().length > 0 ? raw.key_last4.trim() : null;

  return CREDENTIAL_PROVIDERS.flatMap((metadata) => {
    const secretValue = detectInlineCredentialSecret(raw, metadata);
    const hasSecretReference = typeof raw.secret_ref === "string" && raw.secret_ref.trim().length > 0;
    const shouldInclude =
      Boolean(secretValue) ||
      (hasSecretReference && provider === metadata.provider && metadata.launchableKind === "codex");
    if (!shouldInclude) return [];

    return [
      {
        ...SavedCredentialSchema.parse({
          id: `${row.id}:${metadata.envVar}`,
          credentialRowId: row.id,
          agentId: row.agent_id,
          workspaceId: row.workspace_id,
          provider,
          label: maskCredentialLabel(metadata, keyLast4),
          envVar: metadata.envVar,
          updatedAt: row.updated_at,
          validationState: row.validation_state,
          validatedAt: row.validated_at,
          launchableKind: provider === metadata.provider ? metadata.launchableKind : null,
        }),
        secretValue: secretValue ?? "",
        secretRef: hasSecretReference ? String(raw.secret_ref).trim() : null,
        aliases: [...metadata.aliases],
        endpoint: typeof raw.endpoint === "string" && raw.endpoint.trim().length > 0 ? raw.endpoint.trim() : null,
        apiVersion:
          typeof raw.api_version === "string" && raw.api_version.trim().length > 0 ? raw.api_version.trim() : null,
        oauth: readOAuthFields(raw, provider),
      },
    ];
  });
}

export async function listSavedCredentialsForAgentFromSupabase(
  agentId: string,
  workspaceId: string,
): Promise<ResolvedSavedCredential[]> {
  const rows = await listAgentCredentialRows(agentId, workspaceId);
  return rows.flatMap(toSavedCredentials);
}

export async function listSavedModelProviderCredentialsForWorkspaceFromSupabase(
  workspaceId: string,
  userId?: string | null,
): Promise<ResolvedSavedCredential[]> {
  const rows = await listWorkspaceModelProviderCredentialRows(workspaceId, userId);
  return rows.flatMap(toSavedCredentials);
}

export async function saveInlineCredentialForAgentInSupabase(input: {
  agentId: string;
  workspaceId: string;
  provider: CredentialProvider;
  apiKey: string;
  validationState?: CredentialRow["validation_state"];
  validatedAt?: string | null;
}) {
  const normalizedKey = input.apiKey.trim();
  if (!normalizedKey) {
    throw new Error("API key is required");
  }

  const provider = requireApiKeyCredentialProvider(input.provider);
  const metadata = getCredentialProviderMetadata(provider);
  const existingRows = await listAgentCredentialRows(input.agentId, input.workspaceId);
  const matchingRow =
    existingRows.find((row) => {
      return row.provider === provider;
    }) ?? null;

  const keyValue = {
    [metadata.envVar]: normalizedKey,
    key_last4: normalizedKey.slice(-4),
  } satisfies JsonObject;

  let savedRows: CredentialRow[];
  if (matchingRow) {
    const existingRaw = asJsonObject(matchingRow.key_value) ?? {};
    const saved = await updateCredentialKeyValue({
      credentialId: matchingRow.id,
      keyValue: {
        ...existingRaw,
        ...keyValue,
      },
      updatedAt: new Date().toISOString(),
      validationState: input.validationState,
      validatedAt: input.validatedAt,
    });
    savedRows = saved ? [saved] : [];
  } else {
    const saved = await createAgentCredential({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      userId: null,
      credentialKey: {
        format: "api_key",
        provider,
        secret: normalizedKey,
      },
      validationState: input.validationState,
      validatedAt: input.validatedAt,
    });
    savedRows = saved ? [saved] : [];
  }

  const saved = savedRows[0];
  if (!saved) {
    throw new Error("Credential persistence returned no row");
  }

  const mapped = toSavedCredentials(saved).find((credential) => credential.provider === provider) ?? null;
  if (!mapped) {
    throw new Error("Credential persistence returned no stored credential");
  }

  return mapped;
}

export async function saveModelProviderCredentialForWorkspaceInSupabase(input: {
  workspaceId: string;
  userId: string | null;
  provider: CredentialProvider;
  apiKey: string;
  label?: string | null;
  endpoint?: string | null;
  apiVersion?: string | null;
  validationState?: CredentialRow["validation_state"];
  validatedAt?: string | null;
}) {
  const normalizedKey = input.apiKey.trim();
  if (!normalizedKey) {
    throw new Error("API key is required");
  }

  const provider = requireApiKeyCredentialProvider(input.provider);
  const metadata = getCredentialProviderMetadata(provider);
  const existingRows = await listWorkspaceModelProviderCredentialRows(input.workspaceId, input.userId);
  const matchingRow =
    existingRows.find((row) => {
      return row.provider === provider;
    }) ?? null;

  const keyValue: JsonObject = {
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    [metadata.envVar]: normalizedKey,
    key_last4: normalizedKey.slice(-4),
  };
  if (input.endpoint?.trim()) {
    keyValue.endpoint = input.endpoint.trim();
  }
  if (input.apiVersion?.trim()) {
    keyValue.api_version = input.apiVersion.trim();
  }

  let savedRows: CredentialRow[];
  if (matchingRow) {
    const existingRaw = asJsonObject(matchingRow.key_value) ?? {};
    const saved = await updateCredentialKeyValue({
      credentialId: matchingRow.id,
      keyValue: {
        ...existingRaw,
        ...keyValue,
      },
      updatedAt: new Date().toISOString(),
      validationState: input.validationState,
      validatedAt: input.validatedAt,
    });
    savedRows = saved ? [saved] : [];
  } else {
    const saved = await createWorkspaceModelProviderCredential({
      workspaceId: input.workspaceId,
      userId: input.userId?.trim() || null,
      credentialKey: {
        format: "api_key",
        provider,
        secret: normalizedKey,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        ...(input.endpoint?.trim() ? { endpoint: input.endpoint.trim() } : {}),
        ...(input.apiVersion?.trim() ? { apiVersion: input.apiVersion.trim() } : {}),
      },
      validationState: input.validationState,
      validatedAt: input.validatedAt,
    });
    savedRows = saved ? [saved] : [];
  }

  const saved = savedRows[0];
  if (!saved) {
    throw new Error("Credential persistence returned no row");
  }

  const mapped = toSavedCredentials(saved).find((credential) => credential.provider === provider) ?? null;
  if (!mapped) {
    throw new Error("Credential persistence returned no stored credential");
  }

  return mapped;
}

export type OpenAICodexOAuthCredentialInput = {
  agentId: string;
  workspaceId: string;
  tokens: {
    access: string;
    refresh: string;
    expires: number;
  };
  identity: {
    accountId?: string;
    chatgptPlanType?: string;
    email?: string;
  };
};

export type OpenAICodexAccessTokenCredentialInput = {
  agentId: string;
  workspaceId: string;
  accessToken: string;
  expiresAt?: number | null;
  identity: {
    accountId?: string;
    chatgptPlanType?: string;
    email?: string;
  };
};

/**
 * Persist an OpenAI Codex OAuth credential for an agent. Stores tokens and
 * identity metadata inside `credential.key_value` JSONB; no DB migration is
 * required. The credential is exposed as a `SavedCredential` with the
 * `openai_codex` provider so the existing routing/launch path picks it up.
 */
export async function saveOpenAICodexOAuthCredentialForAgent(
  input: OpenAICodexOAuthCredentialInput,
): Promise<ResolvedSavedCredential> {
  const access = input.tokens.access.trim();
  const refresh = input.tokens.refresh.trim();
  if (!access || !refresh) {
    throw new Error("OAuth tokens are required");
  }

  const existingRows = await listAgentCredentialRows(input.agentId, input.workspaceId);
  const matchingRow =
    existingRows.find((row) => {
      return row.provider === "openai_codex";
    }) ?? null;

  const keyValue: JsonObject = {
    access_token: access,
    refresh_token: refresh,
    expires_at: input.tokens.expires,
    key_last4: access.slice(-4),
    ...(input.identity.accountId ? { account_id: input.identity.accountId } : {}),
    ...(input.identity.chatgptPlanType ? { plan_type: input.identity.chatgptPlanType } : {}),
    ...(input.identity.email ? { email: input.identity.email } : {}),
  };

  let savedRows: CredentialRow[];
  if (matchingRow) {
    const existingRaw = asJsonObject(matchingRow.key_value) ?? {};
    const saved = await updateCredentialKeyValue({
      credentialId: matchingRow.id,
      keyValue: {
        ...existingRaw,
        ...keyValue,
      },
      updatedAt: new Date().toISOString(),
      validationState: "ok",
      validatedAt: new Date().toISOString(),
    });
    savedRows = saved ? [saved] : [];
  } else {
    const saved = await createAgentCredential({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      userId: null,
      credentialKey: {
        format: "oauth",
        provider: "openai_codex",
        access,
        refresh,
        expiresAt: input.tokens.expires,
        identity: {
          ...(input.identity.accountId ? { accountId: input.identity.accountId } : {}),
          ...(input.identity.chatgptPlanType ? { chatgptPlanType: input.identity.chatgptPlanType } : {}),
          ...(input.identity.email ? { email: input.identity.email } : {}),
        },
      },
      validationState: "ok",
      validatedAt: new Date().toISOString(),
    });
    savedRows = saved ? [saved] : [];
  }

  const saved = savedRows[0];
  if (!saved) {
    throw new Error("Credential persistence returned no row");
  }
  const mapped = toSavedCredentials(saved).find((credential) => credential.provider === "openai_codex") ?? null;
  if (!mapped) {
    throw new Error("Credential persistence returned no stored credential");
  }
  return mapped;
}

export async function saveOpenAICodexAccessTokenCredentialForAgent(
  input: OpenAICodexAccessTokenCredentialInput,
): Promise<ResolvedSavedCredential> {
  const access = input.accessToken.trim();
  if (!access) {
    throw new Error("OAuth access token is required");
  }

  const existingRows = await listAgentCredentialRows(input.agentId, input.workspaceId);
  const matchingRow =
    existingRows.find((row) => {
      const raw = asJsonObject(row.key_value);
      return credentialRecordMatchesProvider(raw, "openai_codex");
    }) ?? null;

  const keyValue: JsonObject = {
    provider: "openai_codex",
    access_token: access,
    expires_at: input.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
    key_last4: access.slice(-4),
    ...(input.identity.accountId ? { account_id: input.identity.accountId } : {}),
    ...(input.identity.chatgptPlanType ? { plan_type: input.identity.chatgptPlanType } : {}),
    ...(input.identity.email ? { email: input.identity.email } : {}),
  };

  let savedRows: CredentialRow[];
  if (matchingRow) {
    const existingRaw = asJsonObject(matchingRow.key_value) ?? {};
    const existingWithoutRefresh = { ...existingRaw };
    delete existingWithoutRefresh.refresh_token;
    delete existingWithoutRefresh.account_id;
    delete existingWithoutRefresh.plan_type;
    delete existingWithoutRefresh.email;
    const saved = await updateCredentialKeyValue({
      credentialId: matchingRow.id,
      keyValue: {
        ...existingWithoutRefresh,
        ...keyValue,
      },
      updatedAt: new Date().toISOString(),
    });
    savedRows = saved ? [saved] : [];
  } else {
    const saved = await createAgentCredential({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      userId: null,
      credentialKey: {
        format: "oauth",
        provider: "openai_codex",
        access,
        expiresAt: input.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
        keyLast4: access.slice(-4),
        identity: {
          ...(input.identity.accountId ? { accountId: input.identity.accountId } : {}),
          ...(input.identity.chatgptPlanType ? { chatgptPlanType: input.identity.chatgptPlanType } : {}),
          ...(input.identity.email ? { email: input.identity.email } : {}),
        },
      },
    });
    savedRows = saved ? [saved] : [];
  }

  const saved = savedRows[0];
  if (!saved) {
    throw new Error("Credential persistence returned no row");
  }
  const mapped = toSavedCredentials(saved).find((credential) => credential.provider === "openai_codex") ?? null;
  if (!mapped) {
    throw new Error("Credential persistence returned no stored credential");
  }
  return mapped;
}
