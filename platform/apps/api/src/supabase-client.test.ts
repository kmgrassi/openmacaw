import { createClient, type PostgrestError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiSupabaseConfigError,
  ApiSupabaseQueryError,
  executeLoggedSupabaseRows,
  getServiceRoleSupabase,
  getUserScopedSupabase,
  normalizeSupabaseQueryError,
  resetSupabaseClientForTests,
} from "./supabase-client.js";
import { logEvent } from "./logger.js";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn((url: string, key: string, options: unknown) => ({ key, options, url })),
}));

vi.mock("./logger.js", () => ({
  logEvent: vi.fn(),
}));

const TEST_ENV: NodeJS.ProcessEnv = {
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  SUPABASE_URL: "https://example.supabase.co/",
};
const mockedCreateClient = vi.mocked(createClient);

describe("supabase-client", () => {
  beforeEach(() => {
    mockedCreateClient.mockClear();
    vi.mocked(logEvent).mockClear();
    resetSupabaseClientForTests();
  });

  afterEach(() => {
    resetSupabaseClientForTests();
  });

  it("validates required service role configuration", () => {
    const env: NodeJS.ProcessEnv = {};

    expect(() => getServiceRoleSupabase(env)).toThrow(ApiSupabaseConfigError);
    expect(() => getServiceRoleSupabase(env)).toThrow(
      "Supabase server access is not configured: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are required",
    );
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("creates one typed service-role client with trimmed configuration", () => {
    const firstClient = getServiceRoleSupabase(TEST_ENV);
    const secondClient = getServiceRoleSupabase(TEST_ENV);

    expect(firstClient).toBe(secondClient);
    expect(mockedCreateClient).toHaveBeenCalledTimes(1);
    expect(mockedCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
      expect.objectContaining({
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      }),
    );
  });

  it("creates user-scoped clients with the anon key and user bearer token", () => {
    const env: NodeJS.ProcessEnv = { ...TEST_ENV, SUPABASE_ANON_KEY: "anon-key" };

    const firstClient = getUserScopedSupabase(" user-access-token ", env);
    const secondClient = getUserScopedSupabase("other-token", env);

    expect(firstClient).not.toBe(secondClient);
    expect(mockedCreateClient).toHaveBeenCalledTimes(2);
    expect(mockedCreateClient).toHaveBeenNthCalledWith(
      1,
      "https://example.supabase.co",
      "anon-key",
      expect.objectContaining({
        global: {
          headers: {
            Authorization: "Bearer user-access-token",
          },
        },
      }),
    );
  });

  it("does not retain a client cache keyed by user access token", () => {
    const firstClient = getUserScopedSupabase("user-access-token", TEST_ENV);
    const secondClient = getUserScopedSupabase("user-access-token", TEST_ENV);

    expect(firstClient).not.toBe(secondClient);
    expect(mockedCreateClient).toHaveBeenCalledTimes(2);
  });

  it("falls back to the service role key as the user-scoped apikey", () => {
    getUserScopedSupabase("user-access-token", TEST_ENV);

    expect(mockedCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
      expect.objectContaining({
        global: {
          headers: {
            Authorization: "Bearer user-access-token",
          },
        },
      }),
    );
  });

  it("rejects blank user access tokens", () => {
    expect(() => getUserScopedSupabase("   ", TEST_ENV)).toThrow(ApiSupabaseConfigError);
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("normalizes Supabase query errors", () => {
    const postgrestError = {
      code: "PGRST116",
      details: "0 rows",
      hint: "Use maybeSingle",
      message: "JSON object requested, multiple or no rows returned",
      name: "PostgrestError",
    } as PostgrestError;

    const normalized = normalizeSupabaseQueryError(postgrestError, "Agent lookup failed");

    expect(normalized).toBeInstanceOf(ApiSupabaseQueryError);
    expect(normalized).toMatchObject({
      code: "PGRST116",
      details: "0 rows",
      hint: "Use maybeSingle",
      message: "Agent lookup failed: JSON object requested, multiple or no rows returned",
    });
  });

  it("returns null when there is no Supabase query error", () => {
    expect(normalizeSupabaseQueryError(null)).toBeNull();
  });

  it("logs database query start and completion with row count metadata", async () => {
    const rows = await executeLoggedSupabaseRows<{ id: string }>(
      {
        operation: "agent_dashboard.load_agents",
        table: "agent",
      },
      Promise.resolve({
        data: [{ id: "agent-1" }, { id: "agent-2" }],
        error: null,
      }),
    );

    expect(rows).toEqual([{ id: "agent-1" }, { id: "agent-2" }]);
    expect(logEvent).toHaveBeenNthCalledWith(1, {
      event: "database_query_started",
      layer: "database",
      operation: "agent_dashboard.load_agents",
      table: "agent",
    });
    expect(logEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "database_query_completed",
        layer: "database",
        operation: "agent_dashboard.load_agents",
        table: "agent",
        row_count: 2,
        result_cardinality: "multiple",
        duration_ms: expect.any(Number),
      }),
    );
  });

  it("logs database query failures with Supabase error fields and no query payload", async () => {
    const postgrestError = {
      code: "23503",
      details: "Key is not present in table.",
      hint: "Check the workspace id.",
      message: "insert or update violates foreign key constraint",
      name: "PostgrestError",
    } as PostgrestError;

    await expect(
      executeLoggedSupabaseRows(
        {
          operation: "agent_dashboard.load_tasks",
          table: "broker_task",
        },
        Promise.resolve({
          data: null,
          error: postgrestError,
        }),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      details: "Key is not present in table.",
      hint: "Check the workspace id.",
    });

    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "database_query_failed",
        level: "error",
        layer: "database",
        operation: "agent_dashboard.load_tasks",
        table: "broker_task",
        error_code: "23503",
        supabase_code: "23503",
        supabase_details: "Key is not present in table.",
        supabase_hint: "Check the workspace id.",
        duration_ms: expect.any(Number),
      }),
    );
    expect(logEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.anything(),
      }),
    );
    expect(logEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: expect.anything(),
      }),
    );
  });
});
