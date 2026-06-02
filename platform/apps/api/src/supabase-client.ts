import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@kmgrassi/supabase-schema";
import { logSupabaseError } from "./lib/supabase-errors.js";
import { logEvent } from "./logger.js";

type ApiSupabaseConfig = {
  url: string;
  serviceRoleKey: string;
  anonKey: string | null;
};

export type ApiSupabaseClient = SupabaseClient<Database>;

export class ApiSupabaseConfigError extends Error {
  readonly code = "supabase_config_missing";

  constructor(missingNames: string[]) {
    super(
      `Supabase server access is not configured: ${missingNames.join(", ")} ${missingNames.length === 1 ? "is" : "are"} required`,
    );
    this.name = "ApiSupabaseConfigError";
  }
}

export class ApiSupabaseQueryError extends Error {
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(error: PostgrestError, context = "Supabase query failed") {
    super(`${context}: ${error.message}`);
    this.name = "ApiSupabaseQueryError";
    this.code = error.code || null;
    this.details = error.details || null;
    this.hint = error.hint || null;
  }
}

let serviceRoleClient: ApiSupabaseClient | null = null;

function readSupabaseConfig(env: NodeJS.ProcessEnv = process.env): ApiSupabaseConfig {
  const url = (env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const anonKey = (env.SUPABASE_ANON_KEY ?? "").trim() || null;
  const missingNames: string[] = [];

  if (!url) missingNames.push("SUPABASE_URL");
  if (!serviceRoleKey) missingNames.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missingNames.length > 0) {
    throw new ApiSupabaseConfigError(missingNames);
  }

  return { url, serviceRoleKey, anonKey };
}

function clientOptions(authorizationBearer?: string) {
  return {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: authorizationBearer
      ? {
          headers: {
            Authorization: `Bearer ${authorizationBearer}`,
          },
        }
      : undefined,
  };
}

export function getServiceRoleSupabase(env: NodeJS.ProcessEnv = process.env): ApiSupabaseClient {
  if (serviceRoleClient) return serviceRoleClient;

  const config = readSupabaseConfig(env);
  serviceRoleClient = createClient<Database>(config.url, config.serviceRoleKey, clientOptions());
  return serviceRoleClient;
}

export function getUserScopedSupabase(accessToken: string, env: NodeJS.ProcessEnv = process.env): ApiSupabaseClient {
  const trimmedAccessToken = accessToken.trim();

  if (!trimmedAccessToken) {
    throw new ApiSupabaseConfigError(["accessToken"]);
  }

  const config = readSupabaseConfig(env);
  return createClient<Database>(config.url, config.anonKey ?? config.serviceRoleKey, clientOptions(trimmedAccessToken));
}

export type SupabaseAuthUserResponse = {
  id?: string;
  email?: string | null;
};

export async function supabaseAuthUser(accessToken: string): Promise<SupabaseAuthUserResponse> {
  const { data, error } = await getUserScopedSupabase(accessToken).auth.getUser(accessToken);
  if (error) {
    throw new Error(`Supabase auth user lookup failed: ${error.message}`);
  }
  return {
    id: data.user?.id,
    email: data.user?.email ?? null,
  };
}

export function getSupabaseForAccessToken(accessToken?: string): ApiSupabaseClient {
  return accessToken ? getUserScopedSupabase(accessToken) : getServiceRoleSupabase();
}

export async function executeSupabaseRows<Row>(
  context: string,
  query: PromiseLike<{ data: unknown; error: PostgrestError | null }>,
): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw normalizeSupabaseError(context, error);
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]) as Row[];
}

type DatabaseResultCardinality = "none" | "single" | "multiple";

export type SupabaseQueryLogOptions = {
  operation: string;
  table: string;
};

function resultCardinality(rowCount: number): DatabaseResultCardinality {
  if (rowCount === 0) return "none";
  if (rowCount === 1) return "single";
  return "multiple";
}

function supabaseErrorFields(error: unknown) {
  if (error instanceof ApiSupabaseQueryError) {
    return {
      error_code: error.code,
      supabase_code: error.code,
      supabase_message: error.message,
      supabase_details: error.details,
      supabase_hint: error.hint,
    };
  }

  return {
    error_code: error instanceof Error ? error.name : "unknown_database_error",
    supabase_message: error instanceof Error ? error.message : String(error),
  };
}

export async function executeLoggedSupabaseRows<Row>(
  options: SupabaseQueryLogOptions,
  query: PromiseLike<{ data: unknown; error: PostgrestError | null }>,
): Promise<Row[]> {
  const startedAt = Date.now();
  const baseLogFields = {
    layer: "database",
    operation: options.operation,
    table: options.table,
  };

  logEvent({
    event: "database_query_started",
    ...baseLogFields,
  });

  try {
    const rows = await executeSupabaseRows<Row>(options.operation, query);
    const rowCount = rows.length;

    logEvent({
      event: "database_query_completed",
      ...baseLogFields,
      duration_ms: Date.now() - startedAt,
      row_count: rowCount,
      result_cardinality: resultCardinality(rowCount),
    });

    return rows;
  } catch (error) {
    logEvent({
      event: "database_query_failed",
      level: "error",
      ...baseLogFields,
      ...supabaseErrorFields(error),
      duration_ms: Date.now() - startedAt,
    });

    throw error;
  }
}

export function normalizeSupabaseQueryError(
  error: PostgrestError | null | undefined,
  context?: string,
): ApiSupabaseQueryError | null {
  return error ? new ApiSupabaseQueryError(error, context) : null;
}

export function normalizeSupabaseError(context: string, error: PostgrestError): Error {
  logSupabaseError(context, error);
  return normalizeSupabaseQueryError(error, `Supabase ${context} failed`) ?? new Error(`Supabase ${context} failed`);
}

export function resetSupabaseClientForTests(): void {
  serviceRoleClient = null;
}
