import type { Json } from "@kmgrassi/supabase-schema";
import { z } from "zod";

import { logEvent } from "../logger.js";

export const JsonValueSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export class SupabaseRowParseError extends Error {
  readonly code = "invalid_supabase_row";
  readonly context: string;
  readonly details: z.ZodIssue[];
  readonly hint = "Check the repository select list, generated Supabase types, and row schema.";

  constructor(context: string, error: z.ZodError) {
    super(`Supabase ${context} returned invalid row data`);
    this.name = "SupabaseRowParseError";
    this.context = context;
    this.details = error.issues;
  }
}

function invalidRowError(context: string, error: z.ZodError): SupabaseRowParseError {
  const formatted = {
    context,
    code: "invalid_supabase_row",
    message: "Supabase returned row data that did not match the repository schema",
    details: error.issues,
    hint: "Check the repository select list, generated Supabase types, and row schema.",
  };
  logEvent({
    event: "supabase_row_parse_error",
    level: "error",
    supabase_context: formatted.context,
    supabase_code: formatted.code,
    supabase_message: formatted.message,
    supabase_details: formatted.details,
    supabase_hint: formatted.hint,
  });
  return new SupabaseRowParseError(context, error);
}

export function parseSupabaseRow<Schema extends z.ZodType>(
  context: string,
  schema: Schema,
  row: unknown,
): z.infer<Schema> {
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw invalidRowError(context, parsed.error);
  return parsed.data;
}

export function parseSupabaseRows<Schema extends z.ZodType>(
  context: string,
  schema: Schema,
  rows: unknown[] | null | undefined,
): z.infer<Schema>[] {
  const parsed = z.array(schema).safeParse(rows ?? []);
  if (!parsed.success) throw invalidRowError(context, parsed.error);
  return parsed.data;
}

export function parseNullableSupabaseRow<Schema extends z.ZodType>(
  context: string,
  schema: Schema,
  row: unknown | null | undefined,
): z.infer<Schema> | null {
  if (row == null) return null;
  return parseSupabaseRow(context, schema, row);
}
