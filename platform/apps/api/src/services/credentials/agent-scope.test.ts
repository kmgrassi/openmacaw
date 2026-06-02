import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeLoggedSupabaseRows, getSupabaseForAccessToken } from "../../supabase-client.js";
import { countCredentialsForAgent, hasCredentialForAgent, type AgentScopeFields } from "./agent-scope.js";

vi.mock("../../supabase-client.js", () => ({
  executeLoggedSupabaseRows: vi.fn(),
  getSupabaseForAccessToken: vi.fn(),
}));

const mockedExecuteRows = vi.mocked(executeLoggedSupabaseRows);
const mockedGetSupabaseForAccessToken = vi.mocked(getSupabaseForAccessToken);

const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const creatorUserId = "99999999-9999-4999-8999-999999999999";
const agentId = "33333333-3333-4333-8333-333333333333";

type QueryCall = { method: "select" | "eq" | "or" | "limit"; args: unknown[] };
type QueryBuilder = {
  calls: QueryCall[];
  select: (...args: unknown[]) => QueryBuilder;
  eq: (...args: unknown[]) => QueryBuilder;
  or: (...args: unknown[]) => QueryBuilder;
  limit: (...args: unknown[]) => QueryBuilder;
};

const queryBuilders: QueryBuilder[] = [];

function queryBuilderAt(index: number): QueryBuilder {
  const builder = queryBuilders[index];
  if (!builder) {
    throw new Error(`query builder ${index} was not created`);
  }
  return builder;
}

function createQueryBuilder(): QueryBuilder {
  const builder = {
    calls: [] as QueryCall[],
    select(...args: unknown[]) {
      this.calls.push({ method: "select", args });
      return this;
    },
    eq(...args: unknown[]) {
      this.calls.push({ method: "eq", args });
      return this;
    },
    or(...args: unknown[]) {
      this.calls.push({ method: "or", args });
      return this;
    },
    limit(...args: unknown[]) {
      this.calls.push({ method: "limit", args });
      return this;
    },
  };
  queryBuilders.push(builder);
  return builder;
}

function expectEq(builder: QueryBuilder, column: string, value: unknown) {
  expect(builder.calls).toContainEqual({ method: "eq", args: [column, value] });
}

function expectOr(builder: QueryBuilder, expression: string) {
  expect(builder.calls).toContainEqual({ method: "or", args: [expression] });
}

function agent(overrides: Partial<AgentScopeFields> = {}): AgentScopeFields {
  return {
    id: agentId,
    workspace_id: workspaceId,
    model_settings: { primary: "openai/gpt-5" },
    ...overrides,
  };
}

beforeEach(() => {
  queryBuilders.length = 0;
  mockedExecuteRows.mockReset();
  mockedGetSupabaseForAccessToken.mockReset();
  mockedGetSupabaseForAccessToken.mockReturnValue({
    from: vi.fn(() => createQueryBuilder()),
  } as never);
});

describe("countCredentialsForAgent", () => {
  it("queries credential by provider + (workspace OR user) scope", async () => {
    mockedExecuteRows.mockResolvedValueOnce([{ id: "cred-1" }]);

    const count = await countCredentialsForAgent("token", userId, agent());

    expect(count).toBe(1);
    expect(mockedExecuteRows).toHaveBeenCalledOnce();
    expect(mockedExecuteRows).toHaveBeenCalledWith(
      {
        operation: "credentials.agent_scope.count_credentials",
        table: "credential",
      },
      expect.anything(),
    );
    expect(mockedGetSupabaseForAccessToken.mock.results[0]?.value.from).toHaveBeenCalledWith("credential");
    const builder = queryBuilderAt(0);
    expectEq(builder, "provider", "openai");
    expectOr(builder, `workspace_id.eq.${workspaceId},user_id.eq.${userId}`);
  });

  it("returns 0 without querying when the agent has no primary model", async () => {
    const count = await countCredentialsForAgent("token", userId, agent({ model_settings: {} }));

    expect(count).toBe(0);
    expect(mockedExecuteRows).not.toHaveBeenCalled();
  });

  it("returns 0 when the model provider does not normalize to a known credential provider", async () => {
    const count = await countCredentialsForAgent(
      "token",
      userId,
      agent({ model_settings: { primary: "unknown-provider/gpt-x" } }),
    );

    expect(count).toBe(0);
    expect(mockedExecuteRows).not.toHaveBeenCalled();
  });

  it("rethrows underlying Supabase errors instead of swallowing them", async () => {
    mockedExecuteRows.mockRejectedValueOnce(new Error("Supabase credential query failed (500): server_error"));

    await expect(countCredentialsForAgent("token", userId, agent())).rejects.toThrow(/server_error/);
    expect(mockedExecuteRows).toHaveBeenCalledOnce();
  });

  it("rethrows missing-column errors instead of falling back to a dropped column", async () => {
    mockedExecuteRows.mockRejectedValueOnce(
      new Error(
        'Supabase credential query failed (400): {"code":"42703","message":"column credential.provider does not exist"}',
      ),
    );

    await expect(countCredentialsForAgent("token", userId, agent())).rejects.toThrow(
      /credential\.provider does not exist/,
    );
    expect(mockedExecuteRows).toHaveBeenCalledOnce();
  });

  it("uses the requester user_id rather than the agent creator for user-scoped credentials", async () => {
    mockedExecuteRows.mockResolvedValueOnce([]);

    await countCredentialsForAgent("token", userId, agent());

    const orCall = queryBuilderAt(0).calls.find((call) => call.method === "or");
    expect(orCall?.args[0]).toBe(`workspace_id.eq.${workspaceId},user_id.eq.${userId}`);
    expect(orCall?.args[0]).not.toContain(creatorUserId);
  });

  it("scopes by user_id only when the agent has no workspace", async () => {
    mockedExecuteRows.mockResolvedValueOnce([]);

    await countCredentialsForAgent("token", userId, agent({ workspace_id: null }));

    const builder = queryBuilderAt(0);
    expect(builder.calls.some((call) => call.method === "or")).toBe(false);
    expectEq(builder, "user_id", userId);
  });

  it("scopes by workspace_id only when there is no requester user_id", async () => {
    mockedExecuteRows.mockResolvedValueOnce([]);

    await countCredentialsForAgent("token", "", agent());

    const builder = queryBuilderAt(0);
    expect(builder.calls.some((call) => call.method === "or")).toBe(false);
    expectEq(builder, "workspace_id", workspaceId);
  });
});

describe("hasCredentialForAgent", () => {
  it("returns true when at least one credential matches", async () => {
    mockedExecuteRows.mockResolvedValueOnce([{ id: "cred-1" }]);
    await expect(hasCredentialForAgent("token", userId, agent())).resolves.toBe(true);
  });

  it("returns false when none match", async () => {
    mockedExecuteRows.mockResolvedValueOnce([]);
    await expect(hasCredentialForAgent("token", userId, agent())).resolves.toBe(false);
  });

  it("returns false when no provider can be derived (no query made)", async () => {
    await expect(hasCredentialForAgent("token", userId, agent({ model_settings: {} }))).resolves.toBe(false);
    expect(mockedExecuteRows).not.toHaveBeenCalled();
  });
});
