import type { PostgrestError } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRouteError } from "../http.js";
import { assertSupabaseSuccess } from "./supabase-errors.js";

vi.mock("../logger.js", () => ({
  logEvent: vi.fn(),
}));

const originalNodeEnv = process.env.NODE_ENV;

const supabaseError: PostgrestError = {
  name: "PostgrestError",
  code: "23505",
  message: 'duplicate key value violates unique constraint "secret_idx"',
  details: "Key (workspace_id)=(workspace-1) already exists.",
  hint: "Use another workspace.",
  toJSON: () => ({
    name: "PostgrestError",
    code: "23505",
    message: 'duplicate key value violates unique constraint "secret_idx"',
    details: "Key (workspace_id)=(workspace-1) already exists.",
    hint: "Use another workspace.",
  }),
};

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe("assertSupabaseSuccess", () => {
  it("does not expose raw Supabase messages outside development", () => {
    process.env.NODE_ENV = "production";

    try {
      assertSupabaseSuccess("create routing rule", null, supabaseError);
      throw new Error("Expected assertSupabaseSuccess to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      expect(error).toMatchObject({
        status: 502,
        code: "database_error",
        message: "Database operation failed",
        details: undefined,
      });
    }
  });

  it("includes Supabase details in development responses", () => {
    process.env.NODE_ENV = "development";

    try {
      assertSupabaseSuccess("create routing rule", null, supabaseError);
      throw new Error("Expected assertSupabaseSuccess to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      expect(error).toMatchObject({
        status: 502,
        code: "database_error",
        message: 'create routing rule: duplicate key value violates unique constraint "secret_idx"',
        details: {
          context: "create routing rule",
          code: "23505",
          message: 'duplicate key value violates unique constraint "secret_idx"',
          details: "Key (workspace_id)=(workspace-1) already exists.",
          hint: "Use another workspace.",
        },
      });
    }
  });
});
