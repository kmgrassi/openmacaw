import type { PostgrestError } from "@supabase/supabase-js";

import { ApiRouteError } from "../http.js";
import { logEvent } from "../logger.js";

/**
 * Structured Supabase error with full details for debugging.
 * In dev, the full error is included in API responses.
 * In production, it's logged but not returned to the client.
 */
export interface SupabaseQueryError {
  context: string;
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
}

export function formatSupabaseError(context: string, error: PostgrestError): SupabaseQueryError {
  return {
    context,
    code: error.code ?? null,
    message: error.message ?? "Unknown database error",
    details: error.details ?? null,
    hint: error.hint ?? null,
  };
}

/**
 * Log a Supabase error with full context using the structured logger.
 * Returns the formatted error for inclusion in API responses.
 */
export function logSupabaseError(context: string, error: PostgrestError): SupabaseQueryError {
  const formatted = formatSupabaseError(context, error);
  logEvent({
    event: "supabase_query_error",
    level: "error",
    supabase_context: formatted.context,
    supabase_code: formatted.code,
    supabase_message: formatted.message,
    supabase_details: formatted.details,
    supabase_hint: formatted.hint,
  });
  return formatted;
}

/**
 * Check a Supabase response and throw an ApiRouteError if there's an error.
 * Includes the full DB error details in dev mode.
 */
export function assertSupabaseSuccess<T>(
  context: string,
  data: T | null,
  error: PostgrestError | null,
  httpStatus = 502,
): asserts data is T {
  if (error || !data) {
    const includeDetails = process.env.NODE_ENV === "development";
    const formatted = error ? logSupabaseError(context, error) : { context, message: "No data returned" };
    throw new ApiRouteError(
      httpStatus,
      "database_error",
      includeDetails ? `${context}: ${formatted.message}` : "Database operation failed",
      includeDetails ? formatted : undefined,
    );
  }
}

/**
 * Check a Supabase response where a null row is an expected result, such as
 * `maybeSingle()` lookups that intentionally model zero-or-one cardinality.
 */
export function assertSupabaseNoError(context: string, error: PostgrestError | null, httpStatus = 502) {
  if (!error) return;

  const includeDetails = process.env.NODE_ENV === "development";
  const formatted = logSupabaseError(context, error);
  throw new ApiRouteError(
    httpStatus,
    "database_error",
    includeDetails ? `${context}: ${formatted.message}` : "Database operation failed",
    includeDetails ? formatted : undefined,
  );
}
