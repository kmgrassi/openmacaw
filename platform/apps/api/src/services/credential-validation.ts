import type { CredentialValidationResult } from "../../../../contracts/credentials.js";
import { normalizeCredentialProvider, type CredentialProvider } from "../../../../contracts/credentials.js";
import { MODEL_PROVIDER_IDS, type ModelProvider } from "../../../../contracts/provider-registry.js";
import { asRecord } from "../../../../contracts/agent-helpers.js";
import { errorMessage, logEvent } from "../logger.js";
import {
  getCredentialRowByIdForWorkspace,
  listCredentialsForValidation,
  updateCredentialValidationState,
  type CredentialProjection,
} from "../repositories/credentials.js";
import { validateOpenAiCredential } from "../provider-validation.js";
import { resolveSecretReference } from "../secrets.js";
import { validateModelProviderCredential } from "./model-catalog.js";
import { toSavedCredentials } from "./saved-credentials.js";
import { resolveStoredCredentialSecret } from "./stored-credentials.js";

const STALE_CREDENTIAL_AGE_MS = 24 * 60 * 60 * 1000;
const REVALIDATION_INTERVAL_MS = 60 * 60 * 1000;
const REVALIDATION_BATCH_SIZE = 25;
const MODEL_CREDENTIAL_PROVIDERS = new Set<string>(MODEL_PROVIDER_IDS);

type ValidationState = "ok" | "invalid" | "expired" | "unknown";
type JsonObject = Record<string, unknown>;

function resultState(result: CredentialValidationResult): ValidationState {
  if (result.ok) return "ok";
  return result.code === "credential_expired" || result.code === "oauth_refresh_failed" ? "expired" : "invalid";
}

function validationResult(input: {
  ok: boolean;
  provider: string;
  checkedAt?: string;
  status?: number | null;
  code?: string | null;
  message: string;
}): CredentialValidationResult {
  return {
    ok: input.ok,
    provider: input.provider,
    model: null,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    status: input.status ?? null,
    code: input.code ?? null,
    message: input.message,
  };
}

function readProvider(raw: JsonObject): string | null {
  return typeof raw.provider === "string" && raw.provider.trim().length > 0 ? raw.provider.trim() : null;
}

function readEndpoint(raw: JsonObject): string | null {
  return typeof raw.endpoint === "string" && raw.endpoint.trim().length > 0 ? raw.endpoint.trim() : null;
}

function readApiVersion(raw: JsonObject): string | null {
  return typeof raw.api_version === "string" && raw.api_version.trim().length > 0 ? raw.api_version.trim() : null;
}

function readExpiry(raw: JsonObject): number | null {
  const value = raw.expires_at;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

async function validateSecretRef(raw: JsonObject, provider: CredentialProvider): Promise<CredentialValidationResult> {
  const secretRef = typeof raw.secret_ref === "string" ? raw.secret_ref.trim() : "";
  if (!secretRef) {
    return validationResult({
      ok: false,
      provider,
      code: "secret_ref_missing",
      message: "Secret reference is missing.",
    });
  }

  try {
    await resolveSecretReference(secretRef, [provider]);
    return validationResult({
      ok: true,
      provider,
      message: "Secret reference resolved.",
    });
  } catch (error) {
    return validationResult({
      ok: false,
      provider,
      code: "secret_ref_unresolvable",
      message: error instanceof Error ? error.message : "Secret reference could not be resolved.",
    });
  }
}

function asModelProvider(provider: CredentialProvider): ModelProvider | null {
  return MODEL_CREDENTIAL_PROVIDERS.has(provider) ? (provider as ModelProvider) : null;
}

async function validateApiKey(input: {
  provider: CredentialProvider;
  apiKey: string;
  endpoint: string | null;
  apiVersion: string | null;
}): Promise<CredentialValidationResult> {
  if (input.provider === "openai") {
    return validateOpenAiCredential(input.apiKey, null);
  }
  if (!MODEL_CREDENTIAL_PROVIDERS.has(input.provider)) {
    return validationResult({
      ok: true,
      provider: input.provider,
      message: `${input.provider} credential stored without model-provider validation.`,
    });
  }

  const modelProvider = asModelProvider(input.provider);
  if (!modelProvider) {
    return validationResult({
      ok: true,
      provider: input.provider,
      message: `${input.provider} credential secret is present.`,
    });
  }

  const result = await validateModelProviderCredential({
    provider: modelProvider,
    apiKey: input.apiKey,
    endpoint: input.endpoint,
    apiVersion: input.apiVersion,
  });
  return validationResult({
    ok: result.ok,
    provider: input.provider,
    checkedAt: result.checkedAt,
    code: result.ok ? null : "provider_rejected",
    message: result.ok
      ? `Validated ${input.provider} credential.`
      : (result.error ?? `${input.provider} rejected the credential.`),
  });
}

export async function validateCredentialRecord(input: {
  raw: JsonObject;
  provider?: CredentialProvider | null;
  apiKey?: string | null;
}): Promise<CredentialValidationResult> {
  const provider = input.provider ?? normalizeCredentialProvider(readProvider(input.raw));
  if (!provider) {
    return validationResult({
      ok: false,
      provider: readProvider(input.raw) ?? "unknown",
      code: "provider_unknown",
      message: "Credential provider is not supported.",
    });
  }

  if (provider === "openai_codex") {
    const expiresAt = readExpiry(input.raw);
    if (expiresAt !== null && expiresAt <= Date.now()) {
      return validationResult({
        ok: false,
        provider,
        code: "credential_expired",
        message: "ChatGPT OAuth access token is expired.",
      });
    }
    const hasAccessToken = typeof input.raw.access_token === "string" && input.raw.access_token.trim().length > 0;
    return validationResult({
      ok: hasAccessToken,
      provider,
      code: hasAccessToken ? null : "credential_missing",
      message: hasAccessToken ? "ChatGPT OAuth token is present and unexpired." : "ChatGPT OAuth token is missing.",
    });
  }

  if (typeof input.raw.secret_ref === "string" && input.raw.secret_ref.trim().length > 0) {
    return validateSecretRef(input.raw, provider);
  }

  const secret = input.apiKey?.trim() || null;
  if (!secret) {
    return validationResult({
      ok: false,
      provider,
      code: "credential_missing",
      message: "Credential secret is missing.",
    });
  }

  return validateApiKey({
    provider,
    apiKey: secret,
    endpoint: readEndpoint(input.raw),
    apiVersion: readApiVersion(input.raw),
  });
}

export async function persistCredentialValidation(input: {
  credentialId: string;
  workspaceId?: string | null;
  result: CredentialValidationResult;
}) {
  return updateCredentialValidationState({
    credentialId: input.credentialId,
    workspaceId: input.workspaceId,
    validationState: resultState(input.result),
    validatedAt: input.result.checkedAt,
  });
}

export async function markCredentialInvalid(input: {
  credentialId: string;
  workspaceId?: string | null;
  checkedAt?: string;
}) {
  return updateCredentialValidationState({
    credentialId: input.credentialId,
    workspaceId: input.workspaceId,
    validationState: "invalid",
    validatedAt: input.checkedAt ?? new Date().toISOString(),
  });
}

async function revalidateCredentialRow(row: CredentialProjection) {
  const saved = toSavedCredentials(row)[0] ?? null;
  if (!saved) {
    await updateCredentialValidationState({
      credentialId: row.id,
      workspaceId: row.workspace_id,
      validationState: "unknown",
      validatedAt: new Date().toISOString(),
    });
    return;
  }

  const raw = asRecord(row.key_value);
  if (!raw) return;

  let secret: string | null;
  try {
    secret = await resolveStoredCredentialSecret(saved);
  } catch (error) {
    if (saved.provider === "openai_codex") return;
    throw error;
  }

  const validationRow =
    saved.provider === "openai_codex" && row.workspace_id
      ? ((await getCredentialRowByIdForWorkspace(row.id, row.workspace_id)) ?? row)
      : row;
  const validationRaw = asRecord(validationRow.key_value);
  if (!validationRaw) return;

  const result = await validateCredentialRecord({
    raw: validationRaw,
    provider: normalizeCredentialProvider(saved.provider),
    apiKey: secret,
  });
  await persistCredentialValidation({
    credentialId: row.id,
    workspaceId: row.workspace_id,
    result,
  });
}

export async function revalidateStaleCredentials(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_CREDENTIAL_AGE_MS).toISOString();
  const rows = await listCredentialsForValidation({
    staleBefore,
    limit: REVALIDATION_BATCH_SIZE,
  });
  for (const row of rows) {
    try {
      await revalidateCredentialRow(row);
    } catch (error) {
      logEvent({
        event: "credential_revalidation_failed",
        level: "error",
        credentialId: row.id,
        error_message: errorMessage(error),
      });
      await updateCredentialValidationState({
        credentialId: row.id,
        workspaceId: row.workspace_id,
        validationState: "unknown",
        validatedAt: new Date().toISOString(),
      });
    }
  }
  return rows.length;
}

let revalidationStarted = false;
export function startCredentialRevalidationCron() {
  if (revalidationStarted) return;
  revalidationStarted = true;
  setInterval(() => {
    void revalidateStaleCredentials().catch((error) => {
      logEvent({
        event: "credential_revalidation_cron_failed",
        level: "error",
        error_message: errorMessage(error),
      });
    });
  }, REVALIDATION_INTERVAL_MS).unref();
}
