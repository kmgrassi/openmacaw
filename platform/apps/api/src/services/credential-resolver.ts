import { inspect } from "node:util";

import { asRecord } from "../../../../contracts/agent-helpers.js";
import {
  detectInlineCredentialSecret,
  getCredentialProviderMetadata,
  normalizeCredentialProvider,
  type CredentialProvider,
} from "../../../../contracts/credentials.js";
import type { Json } from "@kmgrassi/supabase-schema";
import { getCredentialRowByIdForWorkspace, type CredentialProjection } from "../repositories/credentials.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { withServiceLogging } from "./service-logging.js";
import { resolveStoredCredentialSecret } from "./stored-credentials.js";

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

type JsonObject = { [key: string]: Json | undefined };

type CredentialReferenceKind = "credential" | "alias";

type NormalizedCredentialReference = {
  kind: CredentialReferenceKind;
  value: string;
};

export type CredentialResolutionInput =
  | string
  | {
      credential_ref?: unknown;
      credential_id?: unknown;
      credential_alias?: unknown;
      dispatch?: unknown;
    };

export type CredentialAliasMap = Record<string, string>;

export type ResolvedCredentialDispatchPayload = {
  id: string;
  workspaceId: string;
  provider: CredentialProvider;
  envVar: string;
  value: string;
  endpoint: string | null;
  apiVersion: string | null;
};

export class CredentialResolveError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CredentialResolveError";
    this.code = code;
  }
}

export class ResolvedCredential {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: CredentialProvider;
  readonly envVar: string;
  readonly endpoint: string | null;
  readonly apiVersion: string | null;
  #secretValue: string;

  constructor(input: ResolvedCredentialDispatchPayload) {
    this.id = input.id;
    this.workspaceId = input.workspaceId;
    this.provider = input.provider;
    this.envVar = input.envVar;
    this.endpoint = input.endpoint;
    this.apiVersion = input.apiVersion;
    this.#secretValue = input.value;
  }

  get secretValue() {
    return this.#secretValue;
  }

  toDispatchPayload(): ResolvedCredentialDispatchPayload {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      provider: this.provider,
      envVar: this.envVar,
      value: this.#secretValue,
      endpoint: this.endpoint,
      apiVersion: this.apiVersion,
    };
  }

  toJSON() {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      provider: this.provider,
      envVar: this.envVar,
      endpoint: this.endpoint,
      apiVersion: this.apiVersion,
      value: "<redacted>",
    };
  }

  [inspectCustom](_depth: number, options: Parameters<typeof inspect>[1]) {
    return `ResolvedCredential ${inspect(this.toJSON(), options)}`;
  }
}

function asJsonObject(value: Json | null): JsonObject | null {
  return asRecord(value) as JsonObject | null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeCredentialReference(input: CredentialResolutionInput): NormalizedCredentialReference {
  if (typeof input === "string") {
    return normalizeCredentialReferenceString(input);
  }

  const dispatch = asRecord(input.dispatch);
  const credentialRef = stringValue(input.credential_ref) ?? stringValue(dispatch?.credential_ref);
  if (credentialRef) return normalizeCredentialReferenceString(credentialRef);

  const credentialId = stringValue(input.credential_id) ?? stringValue(dispatch?.credential_id);
  if (credentialId) {
    return {
      kind: "credential",
      value: stripReferencePrefix(credentialId, "credential"),
    };
  }

  const credentialAlias = stringValue(input.credential_alias) ?? stringValue(dispatch?.credential_alias);
  if (credentialAlias) {
    return {
      kind: "alias",
      value: stripReferencePrefix(credentialAlias, "alias"),
    };
  }

  throw new CredentialResolveError("credential_reference_missing", "Credential reference is required");
}

function normalizeCredentialReferenceString(reference: string): NormalizedCredentialReference {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new CredentialResolveError("credential_reference_missing", "Credential reference is required");
  }

  if (trimmed.startsWith("credential:")) {
    return { kind: "credential", value: stripReferencePrefix(trimmed, "credential") };
  }

  if (trimmed.startsWith("alias:")) {
    return { kind: "alias", value: stripReferencePrefix(trimmed, "alias") };
  }

  return { kind: "credential", value: trimmed };
}

function stripReferencePrefix(reference: string, prefix: CredentialReferenceKind) {
  const normalized = reference.trim();
  const marker = `${prefix}:`;
  return normalized.startsWith(marker) ? normalized.slice(marker.length).trim() : normalized;
}

function extractCredentialAliasMap(configJson: unknown): CredentialAliasMap {
  const config = asRecord(configJson);
  const body = asRecord(config?.body);
  const credentials = asRecord(body?.credentials) ?? asRecord(config?.credentials);
  if (!credentials) return {};

  return Object.fromEntries(
    Object.entries(credentials).flatMap(([alias, value]) => {
      const normalizedAlias = alias.trim();
      const normalizedValue = stringValue(value);
      if (!normalizedAlias || !normalizedValue) return [];
      return [[normalizedAlias, normalizedValue]];
    }),
  );
}

async function loadGatewayCredentialAliases(workspaceId: string): Promise<CredentialAliasMap> {
  const rows = await executeSupabaseRows<{ config_json: Json }>(
    "gateway_config query",
    getServiceRoleSupabase()
      .from("gateway_config")
      .select("config_json")
      .eq("scope_type", "workspace")
      .eq("scope_id", workspaceId)
      .order("version", { ascending: false })
      .limit(1),
  );

  return extractCredentialAliasMap(rows[0]?.config_json);
}

function resolveAlias(alias: string, aliases: CredentialAliasMap): string {
  const target = aliases[alias];
  if (!target) {
    throw new CredentialResolveError("credential_alias_not_found", "Credential alias was not found");
  }

  const normalized = normalizeCredentialReferenceString(target);
  if (normalized.kind !== "credential") {
    throw new CredentialResolveError(
      "credential_alias_invalid",
      "Credential alias must resolve to a credential reference",
    );
  }
  return normalized.value;
}

function providerFromCredential(row: CredentialProjection): CredentialProvider {
  const provider = normalizeCredentialProvider(row.provider);
  if (provider) return provider;

  throw new CredentialResolveError("credential_provider_missing", "Credential provider could not be determined");
}

async function resolveCredentialRowSecret(row: CredentialProjection, provider: CredentialProvider, raw: JsonObject) {
  const metadata = getCredentialProviderMetadata(provider);
  const secretValue = await resolveStoredCredentialSecret({
    secretValue: detectInlineCredentialSecret(raw, metadata) ?? "",
    secretRef: stringValue(raw.secret_ref),
    aliases: [...metadata.aliases],
  });

  if (!secretValue) {
    throw new CredentialResolveError("credential_secret_missing", "Credential secret could not be resolved");
  }

  return new ResolvedCredential({
    id: row.id,
    workspaceId: row.workspace_id ?? "",
    provider,
    envVar: metadata.envVar,
    value: secretValue,
    endpoint: stringValue(raw.endpoint),
    apiVersion: stringValue(raw.api_version),
  });
}

export async function resolveCredential(
  referenceInput: CredentialResolutionInput,
  workspaceId: string,
  aliases: CredentialAliasMap = {},
): Promise<ResolvedCredential> {
  return withServiceLogging(
    {
      operation: "credential_resolution.resolve",
      inputSummary: {
        workspace_id: workspaceId,
        reference_kind: typeof referenceInput === "string" ? "string" : "object",
        alias_count: Object.keys(aliases).length,
      },
    },
    () => resolveCredentialImpl(referenceInput, workspaceId, aliases),
  );
}

async function resolveCredentialImpl(
  referenceInput: CredentialResolutionInput,
  workspaceId: string,
  aliases: CredentialAliasMap,
): Promise<ResolvedCredential> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new CredentialResolveError("workspace_id_missing", "Workspace id is required");
  }

  const reference = normalizeCredentialReference(referenceInput);
  const credentialId =
    reference.kind === "credential"
      ? reference.value
      : resolveAlias(reference.value, {
          ...(await loadGatewayCredentialAliases(normalizedWorkspaceId)),
          ...aliases,
        });

  if (!credentialId) {
    throw new CredentialResolveError("credential_reference_missing", "Credential reference is required");
  }

  const row = await getCredentialRowByIdForWorkspace(credentialId, normalizedWorkspaceId);
  if (!row) {
    throw new CredentialResolveError("credential_not_found", "Credential was not found");
  }

  const raw = asJsonObject(row.key_value);
  if (!raw) {
    throw new CredentialResolveError("credential_payload_invalid", "Credential payload is invalid");
  }

  return resolveCredentialRowSecret(row, providerFromCredential(row), raw);
}

export const credentialResolverInternalsForTests = {
  extractCredentialAliasMap,
  normalizeCredentialReference,
};
