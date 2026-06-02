import { errorMessage, logEvent } from "../logger.js";
import { SupabaseRowParseError } from "../lib/supabase-row-parsers.js";

type RepositoryAccess = "service_role" | "user_scoped";
type RepositoryCardinality = "zero_or_more" | "zero_or_one" | "exactly_one" | "write_only";

export type RepositoryOperationMetadata = {
  repository: string;
  method: string;
  table: string;
  operation: string;
  expectedCardinality: RepositoryCardinality;
  access: RepositoryAccess;
  workspaceId?: string | null;
};

export class RepositoryOperationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly cause: unknown;
  readonly repositoryCode: string;

  constructor(input: {
    code: string;
    message: string;
    cause: unknown;
    details?: Record<string, unknown>;
    status?: number;
  }) {
    super(input.message);
    this.name = "RepositoryOperationError";
    this.status = input.status ?? 502;
    this.code = input.code;
    this.details = input.details;
    this.cause = input.cause;
    this.repositoryCode = input.code;
  }
}

function classifyRepositoryError(error: unknown) {
  if (error instanceof SupabaseRowParseError) {
    return {
      code: "repository_row_parse_error",
      layer: "repository",
      retryable: false,
      supabaseCode: error.code,
      supabaseMessage: error.message,
      supabaseDetails: error.details,
      supabaseHint: error.hint,
    };
  }

  if (isSupabaseQueryError(error)) {
    return {
      code: "repository_database_error",
      layer: "database",
      retryable: false,
      supabaseCode: error.code,
      supabaseMessage: error.message,
      supabaseDetails: error.details,
      supabaseHint: error.hint,
    };
  }

  return {
    code: "repository_operation_error",
    layer: "repository",
    retryable: false,
    supabaseCode: undefined,
    supabaseMessage: undefined,
    supabaseDetails: undefined,
    supabaseHint: undefined,
  };
}

function isSupabaseQueryError(error: unknown): error is {
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
} {
  return error instanceof Error && error.name === "ApiSupabaseQueryError";
}

function responseDetails(metadata: RepositoryOperationMetadata, code: string) {
  return {
    code,
    repository: metadata.repository,
    method: metadata.method,
    table: metadata.table,
    operation: metadata.operation,
    workspaceId: metadata.workspaceId ?? undefined,
  };
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

export async function withRepositoryLogging<T>(
  metadata: RepositoryOperationMetadata,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RepositoryOperationError) {
      throw error;
    }

    const classification = classifyRepositoryError(error);

    logEvent({
      event: "repository_operation_failed",
      level: "error",
      layer: classification.layer,
      error_code: classification.code,
      error_message: errorMessage(error),
      error_name: errorName(error),
      error_stack: errorStack(error),
      retryable: classification.retryable,
      repository: metadata.repository,
      repository_method: metadata.method,
      table: metadata.table,
      operation: metadata.operation,
      expected_cardinality: metadata.expectedCardinality,
      access: metadata.access,
      workspace_id: metadata.workspaceId ?? undefined,
      supabase_code: classification.supabaseCode,
      supabase_message: classification.supabaseMessage,
      supabase_details: classification.supabaseDetails,
      supabase_hint: classification.supabaseHint,
    });

    throw new RepositoryOperationError({
      code: classification.code,
      message: "Repository operation failed",
      cause: error,
      details: responseDetails(metadata, classification.code),
    });
  }
}

export function missingRepositoryRow(
  metadata: RepositoryOperationMetadata,
  causeMessage: string,
): RepositoryOperationError {
  const cause = new Error(causeMessage);
  const code = "repository_missing_row";

  logEvent({
    event: "repository_operation_failed",
    level: "error",
    layer: "repository",
    error_code: code,
    error_message: cause.message,
    retryable: false,
    repository: metadata.repository,
    repository_method: metadata.method,
    table: metadata.table,
    operation: metadata.operation,
    expected_cardinality: metadata.expectedCardinality,
    access: metadata.access,
    workspace_id: metadata.workspaceId ?? undefined,
  });

  return new RepositoryOperationError({
    code,
    message: "Repository operation failed",
    cause,
    details: responseDetails(metadata, code),
  });
}
