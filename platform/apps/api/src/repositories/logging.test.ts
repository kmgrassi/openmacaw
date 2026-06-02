import type { PostgrestError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleApiRouteError } from "../http.js";
import { logEvent } from "../logger.js";
import { ApiSupabaseQueryError } from "../supabase-client.js";
import { missingRepositoryRow, RepositoryOperationError, withRepositoryLogging } from "./logging.js";

vi.mock("../logger.js", () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  logEvent: vi.fn(),
}));

const repositoryMetadata = {
  repository: "agents",
  method: "findSetupAgentById",
  table: "agent",
  operation: "select",
  expectedCardinality: "zero_or_one",
  access: "user_scoped",
  workspaceId: "workspace-1",
} as const;

const supabaseError: PostgrestError = {
  name: "PostgrestError",
  code: "23503",
  message: 'insert or update on table "agent" violates foreign key constraint',
  details: "Key (workspace_id)=(workspace-1) is not present in table workspace.",
  hint: "Create the workspace first.",
  toJSON: () => ({
    name: "PostgrestError",
    code: "23503",
    message: 'insert or update on table "agent" violates foreign key constraint',
    details: "Key (workspace_id)=(workspace-1) is not present in table workspace.",
    hint: "Create the workspace first.",
  }),
};

function responseMock() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("withRepositoryLogging", () => {
  beforeEach(() => {
    vi.mocked(logEvent).mockClear();
  });

  it("logs repository metadata and full Supabase details while preserving the cause", async () => {
    const cause = new ApiSupabaseQueryError(supabaseError, "Supabase agent query failed");

    await expect(
      withRepositoryLogging(repositoryMetadata, async () => {
        throw cause;
      }),
    ).rejects.toMatchObject({
      code: "repository_database_error",
      cause,
      details: {
        code: "repository_database_error",
        repository: "agents",
        method: "findSetupAgentById",
        table: "agent",
        operation: "select",
        workspaceId: "workspace-1",
      },
    });

    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "repository_operation_failed",
        repository: "agents",
        repository_method: "findSetupAgentById",
        table: "agent",
        operation: "select",
        expected_cardinality: "zero_or_one",
        access: "user_scoped",
        workspace_id: "workspace-1",
        supabase_code: "23503",
        supabase_details: "Key (workspace_id)=(workspace-1) is not present in table workspace.",
        supabase_hint: "Create the workspace first.",
      }),
    );
  });

  it("logs the original stack when wrapping unknown repository errors", async () => {
    const cause = new TypeError("Cannot read properties of undefined");

    await expect(
      withRepositoryLogging(repositoryMetadata, async () => {
        throw cause;
      }),
    ).rejects.toMatchObject({
      code: "repository_operation_error",
      cause,
    });

    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "repository_operation_failed",
        error_code: "repository_operation_error",
        error_name: "TypeError",
        error_message: "Cannot read properties of undefined",
        error_stack: expect.stringContaining("TypeError: Cannot read properties of undefined"),
        repository: "agents",
        repository_method: "findSetupAgentById",
      }),
    );
  });

  it("returns sanitized API response details for repository errors", () => {
    const response = responseMock();
    const error = new RepositoryOperationError({
      code: "repository_database_error",
      message: "Repository operation failed",
      cause: new Error("raw database details"),
      details: {
        code: "repository_database_error",
        repository: "agents",
        method: "findSetupAgentById",
        table: "agent",
        operation: "select",
      },
    });

    handleApiRouteError(response as never, error, {
      status: 500,
      code: "internal_error",
      message: "Request failed",
    });

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: "repository_database_error",
        message: "Repository operation failed",
        details: {
          code: "repository_database_error",
          repository: "agents",
          method: "findSetupAgentById",
          table: "agent",
          operation: "select",
        },
      },
    });
  });

  it("classifies missing rows separately and preserves the original cause", () => {
    const error = missingRepositoryRow(repositoryMetadata, "Routing rule update returned no row");

    expect(error).toMatchObject({
      code: "repository_missing_row",
      cause: expect.any(Error),
      details: expect.objectContaining({
        code: "repository_missing_row",
        repository: "agents",
        method: "findSetupAgentById",
      }),
    });
  });
});
