import { z } from "zod";

import type { Json } from "@kmgrassi/supabase-schema";
import { credentialKeyToRecord, type CredentialKey } from "../../../../contracts/credentials.js";
import { getServiceRoleSupabase, getUserScopedSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { withRepositoryLogging } from "./logging.js";
import { JsonValueSchema, parseNullableSupabaseRow, parseSupabaseRows } from "../lib/supabase-row-parsers.js";

const CredentialRowSchema = z.object({
  agent_id: z.string().nullable(),
  created_at: z.string(),
  display_name: z.string(),
  format: z.string(),
  id: z.string(),
  key_value: JsonValueSchema.nullable(),
  provider: z.string(),
  updated_at: z.string(),
  user_id: z.string().nullable(),
  validated_at: z.string().nullable().default(null),
  validation_state: z.enum(["ok", "invalid", "expired", "unknown"]).default("unknown"),
  workspace_id: z.string().nullable(),
});

const CredentialProjectionSchema = CredentialRowSchema.pick({
  id: true,
  workspace_id: true,
  user_id: true,
  agent_id: true,
  format: true,
  provider: true,
  display_name: true,
  key_value: true,
  updated_at: true,
  validated_at: true,
  validation_state: true,
});

const CredentialAliasRowSchema = z.object({
  alias: z.string(),
  created_at: z.string(),
  credential_id: z.string(),
  id: z.string(),
  user_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
});

const CredentialAliasProjectionSchema = CredentialAliasRowSchema.pick({
  workspace_id: true,
  alias: true,
  credential_id: true,
  created_at: true,
});

const CredentialAgentIdRowSchema = z.object({
  agent_id: z.string().nullable(),
});

export type CredentialRow = z.infer<typeof CredentialRowSchema>;
export type CredentialProjection = z.infer<typeof CredentialProjectionSchema>;
export type CredentialAliasRow = z.infer<typeof CredentialAliasRowSchema>;
export type CredentialAliasProjection = z.infer<typeof CredentialAliasProjectionSchema>;

const CREDENTIAL_SELECT =
  "id,workspace_id,user_id,agent_id,format,provider,display_name,key_value,updated_at,validation_state,validated_at" as const;
const CREDENTIAL_ALIAS_SELECT = "workspace_id,alias,credential_id,created_at" as const;
type CredentialRowsQuery = PromiseLike<{
  data: unknown[] | null;
  error: Parameters<typeof normalizeSupabaseError>[1] | null;
}>;

type UntypedSupabaseResponse = PromiseLike<{
  data: unknown;
  error: Parameters<typeof normalizeSupabaseError>[1] | null;
}>;

type UntypedSupabaseMutation = UntypedSupabaseResponse & {
  eq: (column: string, value: unknown) => UntypedSupabaseMutation;
  select: (columns?: string) => UntypedSupabaseMutation;
  single: () => UntypedSupabaseResponse;
  maybeSingle: () => UntypedSupabaseResponse;
};

type UntypedSupabaseSelect = UntypedSupabaseResponse & {
  or: (filters: string) => UntypedSupabaseSelect;
  neq: (column: string, value: unknown) => UntypedSupabaseSelect;
  order: (column: string, options?: Record<string, unknown>) => UntypedSupabaseSelect;
  limit: (count: number) => UntypedSupabaseResponse;
};

type UntypedSupabaseTable = {
  select: (columns?: string) => UntypedSupabaseSelect;
  update: (values: Record<string, unknown>) => UntypedSupabaseMutation;
  insert: (values: Record<string, unknown>) => UntypedSupabaseMutation;
};

function credentialTable() {
  return getServiceRoleSupabase().from("credential") as unknown as UntypedSupabaseTable;
}

function clientForAccessToken(accessToken?: string) {
  return accessToken ? getUserScopedSupabase(accessToken) : getServiceRoleSupabase();
}

export async function listCredentialAgentIds(agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();

  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "listCredentialAgentIds",
      table: "credential",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
    },
    async () => {
      const credentialTable = getServiceRoleSupabase().from("credential") as {
        select(columns: "agent_id"): {
          in(column: "agent_id", values: string[]): CredentialRowsQuery;
        };
      };
      const { data, error } = await credentialTable.select("agent_id").in("agent_id", agentIds);

      if (error) throw normalizeSupabaseError("credential query", error);
      const rows = parseSupabaseRows("credential query", CredentialAgentIdRowSchema, data);

      return new Set(rows.map((row) => row.agent_id).filter((value): value is string => value !== null));
    },
  );
}

export async function listAgentCredentialRows(agentId: string, workspaceId: string): Promise<CredentialProjection[]> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "listAgentCredentialRows",
      table: "credential",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("credential")
        .select(CREDENTIAL_SELECT)
        .eq("workspace_id", workspaceId)
        .eq("agent_id" as never, agentId)
        .order("updated_at", { ascending: false });

      if (error) throw normalizeSupabaseError("credential query", error);
      return parseSupabaseRows("credential query", CredentialProjectionSchema, data);
    },
  );
}

export async function getCredentialRowByIdForWorkspace(
  credentialId: string,
  workspaceId: string,
): Promise<CredentialProjection | null> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "getCredentialRowByIdForWorkspace",
      table: "credential",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("credential")
        .select(CREDENTIAL_SELECT)
        .eq("id", credentialId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("credential query", error);
      return parseNullableSupabaseRow("credential query", CredentialProjectionSchema, data);
    },
  );
}

export async function listWorkspaceModelProviderCredentialRows(
  workspaceId: string,
  userId?: string | null,
): Promise<CredentialProjection[]> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "listWorkspaceModelProviderCredentialRows",
      table: "credential",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId,
    },
    async () => {
      let query = getServiceRoleSupabase()
        .from("credential")
        .select(CREDENTIAL_SELECT)
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false });
      if (userId?.trim()) {
        query = query.eq("user_id", userId.trim());
      }

      const { data, error } = await query;

      if (error) throw normalizeSupabaseError("credential query", error);
      return parseSupabaseRows("credential query", CredentialProjectionSchema, data);
    },
  );
}

export async function updateCredentialKeyValue(input: {
  credentialId: string;
  keyValue: Json;
  updatedAt: string;
  validationState?: CredentialRow["validation_state"];
  validatedAt?: string | null;
}): Promise<CredentialRow | null> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "updateCredentialKeyValue",
      table: "credential",
      operation: "update",
      expectedCardinality: "zero_or_one",
      access: "service_role",
    },
    async () => {
      const { data, error } = await credentialTable()
        .update({
          key_value: input.keyValue,
          updated_at: input.updatedAt,
          ...(input.validationState ? { validation_state: input.validationState } : {}),
          ...(input.validatedAt !== undefined ? { validated_at: input.validatedAt } : {}),
        })
        .eq("id", input.credentialId)
        .select()
        .maybeSingle();

      if (error) throw normalizeSupabaseError("credential update", error);
      return parseNullableSupabaseRow("credential update", CredentialRowSchema, data);
    },
  );
}

export async function createAgentCredential(input: {
  agentId: string;
  workspaceId: string;
  userId: string | null;
  credentialKey: CredentialKey;
  accessToken?: string;
  validationState?: CredentialRow["validation_state"];
  validatedAt?: string | null;
}): Promise<CredentialRow | null> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "createAgentCredential",
      table: "credential",
      operation: "insert",
      expectedCardinality: "exactly_one",
      access: input.accessToken ? "user_scoped" : "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const keyValue = credentialKeyToRecord(input.credentialKey) as Json;
      const { data, error } = await (
        clientForAccessToken(input.accessToken).from("credential") as unknown as UntypedSupabaseTable
      )
        .insert({
          agent_id: input.agentId,
          workspace_id: input.workspaceId,
          user_id: input.userId,
          format: input.credentialKey.format,
          provider: input.credentialKey.provider,
          display_name: credentialDisplayName(input.credentialKey),
          key_value: keyValue,
          validation_state: input.validationState ?? "unknown",
          validated_at: input.validatedAt ?? null,
        } as never)
        .select()
        .single();

      if (error) throw normalizeSupabaseError("credential insert", error);
      return parseNullableSupabaseRow("credential insert", CredentialRowSchema, data);
    },
  );
}

export async function createWorkspaceModelProviderCredential(input: {
  workspaceId: string;
  userId: string | null;
  validationState?: CredentialRow["validation_state"];
  validatedAt?: string | null;
  credentialKey: CredentialKey;
}): Promise<CredentialRow | null> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "createWorkspaceModelProviderCredential",
      table: "credential",
      operation: "insert",
      expectedCardinality: "exactly_one",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const keyValue = credentialKeyToRecord(input.credentialKey) as Json;
      const { data, error } = await credentialTable()
        .insert({
          agent_id: null,
          workspace_id: input.workspaceId,
          user_id: input.userId,
          format: input.credentialKey.format,
          provider: input.credentialKey.provider,
          display_name: credentialDisplayName(input.credentialKey),
          key_value: keyValue,
          validation_state: input.validationState ?? "unknown",
          validated_at: input.validatedAt ?? null,
        } as never)
        .select()
        .single();

      if (error) throw normalizeSupabaseError("credential insert", error);
      return parseNullableSupabaseRow("credential insert", CredentialRowSchema, data);
    },
  );
}

export async function createWorkspaceResourceCredential(input: {
  workspaceId: string;
  userId: string | null;
  provider: string;
  format: string;
  displayName: string;
  keyValue: Json;
  validationState?: CredentialRow["validation_state"];
  validatedAt?: string | null;
}): Promise<CredentialRow | null> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "createWorkspaceResourceCredential",
      table: "credential",
      operation: "insert",
      expectedCardinality: "exactly_one",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await credentialTable()
        .insert({
          agent_id: null,
          workspace_id: input.workspaceId,
          user_id: input.userId,
          format: input.format,
          provider: input.provider,
          display_name: input.displayName,
          key_value: input.keyValue,
          validation_state: input.validationState ?? "unknown",
          validated_at: input.validatedAt ?? null,
        } as never)
        .select()
        .single();

      if (error) throw normalizeSupabaseError("credential insert", error);
      return parseNullableSupabaseRow("credential insert", CredentialRowSchema, data);
    },
  );
}

export async function updateCredentialValidationState(input: {
  credentialId: string;
  workspaceId?: string | null;
  validationState: CredentialRow["validation_state"];
  validatedAt: string | null;
}): Promise<CredentialProjection | null> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "updateCredentialValidationState",
      table: "credential",
      operation: "update",
      expectedCardinality: "zero_or_one",
      access: "service_role",
      workspaceId: input.workspaceId ?? undefined,
    },
    async () => {
      let query = credentialTable()
        .update({
          validation_state: input.validationState,
          validated_at: input.validatedAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.credentialId);
      if (input.workspaceId) {
        query = query.eq("workspace_id", input.workspaceId);
      }

      const { data, error } = await query.select(CREDENTIAL_SELECT).maybeSingle();
      if (error) throw normalizeSupabaseError("credential validation update", error);
      return parseNullableSupabaseRow("credential validation update", CredentialProjectionSchema, data);
    },
  );
}

export async function listCredentialsForValidation(input: {
  staleBefore: string;
  limit: number;
}): Promise<CredentialProjection[]> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "listCredentialsForValidation",
      table: "credential",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
    },
    async () => {
      const { data, error } = await credentialTable()
        .select(CREDENTIAL_SELECT)
        .or(`validated_at.is.null,validated_at.lt.${input.staleBefore}`)
        .neq("validation_state", "expired")
        .order("validated_at", { ascending: true, nullsFirst: true })
        .limit(input.limit);

      if (error) throw normalizeSupabaseError("credential validation query", error);
      return parseSupabaseRows("credential validation query", CredentialProjectionSchema, data as unknown[] | null);
    },
  );
}

export function credentialDisplayName(key: CredentialKey): string {
  if (key.format === "oauth") {
    const email = key.identity?.email;
    if (typeof email === "string" && email.trim()) return `ChatGPT (${email.trim()})`;
    return "ChatGPT";
  }
  return key.provider;
}

export function normalizeCredentialAlias(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidCredentialAlias(value: string): boolean {
  const alias = normalizeCredentialAlias(value);
  return alias.length >= 1 && alias.length <= 64 && /^[a-z0-9][a-z0-9_-]*$/.test(alias);
}

export async function listCredentialAliases(workspaceId: string): Promise<CredentialAliasProjection[]> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "listCredentialAliases",
      table: "credential_alias",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("credential_alias")
        .select(CREDENTIAL_ALIAS_SELECT)
        .eq("workspace_id", workspaceId)
        .order("alias", { ascending: true });

      if (error) throw normalizeSupabaseError("credential_alias query", error);
      return parseSupabaseRows("credential_alias query", CredentialAliasProjectionSchema, data);
    },
  );
}

export async function resolveCredentialAlias(
  workspaceId: string,
  alias: string,
): Promise<CredentialAliasProjection | null> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "resolveCredentialAlias",
      table: "credential_alias",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const normalizedAlias = normalizeCredentialAlias(alias);
      const { data, error } = await getServiceRoleSupabase()
        .from("credential_alias")
        .select(CREDENTIAL_ALIAS_SELECT)
        .eq("workspace_id", workspaceId)
        .eq("alias", normalizedAlias)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("credential_alias query", error);
      return parseNullableSupabaseRow("credential_alias query", CredentialAliasProjectionSchema, data);
    },
  );
}

export async function upsertCredentialAlias(input: {
  workspaceId: string;
  alias: string;
  credentialId: string;
}): Promise<CredentialAliasProjection | null> {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "upsertCredentialAlias",
      table: "credential_alias",
      operation: "upsert",
      expectedCardinality: "exactly_one",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const normalizedAlias = normalizeCredentialAlias(input.alias);
      if (!isValidCredentialAlias(normalizedAlias)) {
        throw new Error("Credential alias must be 1-64 lowercase letters, numbers, dashes, or underscores");
      }

      const { data, error } = await getServiceRoleSupabase()
        .from("credential_alias")
        .upsert(
          {
            workspace_id: input.workspaceId,
            alias: normalizedAlias,
            credential_id: input.credentialId,
          },
          { onConflict: "workspace_id,alias" },
        )
        .select(CREDENTIAL_ALIAS_SELECT)
        .single();

      if (error) throw normalizeSupabaseError("credential_alias upsert", error);
      return parseNullableSupabaseRow("credential_alias upsert", CredentialAliasProjectionSchema, data);
    },
  );
}

export async function deleteCredentialAlias(input: { workspaceId: string; alias: string }) {
  return withRepositoryLogging(
    {
      repository: "credentials",
      method: "deleteCredentialAlias",
      table: "credential_alias",
      operation: "delete",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("credential_alias")
        .delete()
        .eq("workspace_id", input.workspaceId)
        .eq("alias", normalizeCredentialAlias(input.alias))
        .select();

      if (error) throw normalizeSupabaseError("credential_alias delete", error);
      return parseSupabaseRows("credential_alias delete", CredentialAliasRowSchema, data);
    },
  );
}
