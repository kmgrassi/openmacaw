import { beforeEach, describe, expect, it, vi } from "vitest";

import { KNOWN_EXECUTION_PROVIDER_IDS } from "../../../../contracts/provider-registry.js";
import { RUNNER_KINDS } from "../../../../contracts/runner-kinds.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import {
  ROUTING_RULE_PROVIDER_ALLOWED,
  ROUTING_RULE_RUNNER_KIND_ALLOWED,
  upsertAgentCredentialReferenceRule,
} from "./routing-rules.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

type MockFn = ReturnType<typeof vi.fn>;
type QueryBuilder = {
  delete: MockFn;
  eq: MockFn;
  insert: MockFn;
  limit: MockFn;
  maybeSingle: MockFn;
  order: MockFn;
  select: MockFn;
  single: MockFn;
  update: MockFn;
  then?: MockFn;
};

function mockBuilder(result: unknown): QueryBuilder {
  const builder: QueryBuilder = {
    delete: vi.fn(),
    eq: vi.fn(),
    insert: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
    order: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
    update: vi.fn(),
  };

  builder.delete.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.insert.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.update.mockReturnValue(builder);
  builder.maybeSingle.mockResolvedValue(result);
  builder.single.mockResolvedValue(result);
  builder.then = vi.fn((resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)));

  return builder;
}

function useBuilders(builders: QueryBuilder[]) {
  const last = builders.at(-1);
  const from = vi.fn().mockImplementation(() => builders.shift() ?? last);
  vi.mocked(getServiceRoleSupabase).mockReturnValue({ from } as never);
  return from;
}

describe("routing rule repository", () => {
  beforeEach(() => {
    vi.mocked(getServiceRoleSupabase).mockReset();
  });

  it("re-enables an existing agent credential rule when repairing it", async () => {
    const existingRule = {
      id: "rule-1",
      workspace_id: "workspace-1",
      name: "agent:agent-1:execution-profile",
      runner_kind: "codex",
      provider: "openai",
      model: "gpt-5",
      credential_id: null,
      credential_alias: "default-openai",
      updated_at: "2026-04-29T12:00:00.000Z",
    };
    const updatedRule = { ...existingRule, updated_at: "2026-04-29T12:01:00.000Z" };
    const currentRuleQuery = mockBuilder({ data: existingRule, error: null });
    const updateQuery = mockBuilder({ data: updatedRule, error: null });
    const matchQuery = mockBuilder({ data: [], error: null });
    const insertMatchQuery = mockBuilder({ data: null, error: null });
    const deleteEndpointQuery = mockBuilder({ data: null, error: null });
    useBuilders([currentRuleQuery, updateQuery, matchQuery, insertMatchQuery, deleteEndpointQuery]);

    await expect(
      upsertAgentCredentialReferenceRule({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        runnerKind: "codex",
        provider: "openai",
        model: "gpt-5",
        credentialRef: { type: "alias", value: "default-openai" },
      }),
    ).resolves.toEqual(updatedRule);

    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        credential_alias: "default-openai",
        credential_id: null,
      }),
    );
    expect(insertMatchQuery.insert).toHaveBeenCalledWith({
      rule_id: "rule-1",
      workspace_id: "workspace-1",
      kind: "agent_id",
      key: "id",
      value: "agent-1",
    });
  });

  it("repairs a concurrently inserted rule after a unique-name race", async () => {
    const concurrentRule = {
      id: "rule-1",
      workspace_id: "workspace-1",
      name: "agent:agent-1:execution-profile",
      runner_kind: "codex",
      provider: "openai",
      model: "gpt-5",
      credential_id: null,
      credential_alias: null,
      updated_at: "2026-04-29T12:00:00.000Z",
    };
    const updatedRule = {
      ...concurrentRule,
      credential_alias: "default-openai",
      updated_at: "2026-04-29T12:01:00.000Z",
    };
    const initialRuleQuery = mockBuilder({ data: null, error: null });
    const duplicateInsertQuery = mockBuilder({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "uq_routing_rule_workspace_name"',
      },
    });
    const concurrentRuleQuery = mockBuilder({ data: concurrentRule, error: null });
    const updateQuery = mockBuilder({ data: updatedRule, error: null });
    const matchQuery = mockBuilder({ data: [], error: null });
    const insertMatchQuery = mockBuilder({ data: null, error: null });
    const deleteEndpointQuery = mockBuilder({ data: null, error: null });
    useBuilders([
      initialRuleQuery,
      duplicateInsertQuery,
      concurrentRuleQuery,
      updateQuery,
      matchQuery,
      insertMatchQuery,
      deleteEndpointQuery,
    ]);

    await expect(
      upsertAgentCredentialReferenceRule({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        runnerKind: "codex",
        provider: "openai",
        model: "gpt-5",
        credentialRef: { type: "alias", value: "default-openai" },
      }),
    ).resolves.toEqual(updatedRule);

    expect(duplicateInsertQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "workspace-1",
        name: "agent:agent-1:execution-profile",
      }),
    );
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        credential_alias: "default-openai",
        credential_id: null,
      }),
    );
    expect(insertMatchQuery.insert).toHaveBeenCalledWith({
      rule_id: "rule-1",
      workspace_id: "workspace-1",
      kind: "agent_id",
      key: "id",
      value: "agent-1",
    });
  });

  it("replaces fallback rows in position order when explicitly provided", async () => {
    const existingRule = {
      id: "rule-1",
      workspace_id: "workspace-1",
      name: "agent:agent-1:execution-profile",
      runner_kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: "primary-credential",
      credential_alias: null,
      model_tier_floor: "any",
      updated_at: "2026-04-29T12:00:00.000Z",
    };
    const updatedRule = {
      ...existingRule,
      model_tier_floor: "frontier",
      updated_at: "2026-04-29T12:01:00.000Z",
    };
    const currentRuleQuery = mockBuilder({ data: existingRule, error: null });
    const updateQuery = mockBuilder({ data: updatedRule, error: null });
    const matchQuery = mockBuilder({ data: [{ id: "match-1" }], error: null });
    const deleteEndpointQuery = mockBuilder({ data: null, error: null });
    const deleteFallbacksQuery = mockBuilder({ data: null, error: null });
    const insertFallbacksQuery = mockBuilder({ data: null, error: null });
    useBuilders([
      currentRuleQuery,
      updateQuery,
      matchQuery,
      deleteEndpointQuery,
      deleteFallbacksQuery,
      insertFallbacksQuery,
    ]);

    await expect(
      upsertAgentCredentialReferenceRule({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        runnerKind: "codex",
        provider: "openai",
        model: "openai/gpt-5.2",
        credentialRef: { type: "credential_id", value: "primary-credential" },
        modelTierFloor: "frontier",
        fallbacks: [
          {
            provider: "anthropic",
            model: "anthropic/claude-sonnet-4-6",
            credentialRef: { type: "alias", value: "default-anthropic" },
          },
          {
            provider: "openai",
            model: "openai/gpt-4.1-mini",
            credentialRef: { type: "credential_id", value: "fallback-openai" },
          },
        ],
      }),
    ).resolves.toEqual(updatedRule);

    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ model_tier_floor: "frontier" }));
    expect(deleteFallbacksQuery.delete).toHaveBeenCalled();
    expect(insertFallbacksQuery.insert).toHaveBeenCalledWith([
      {
        rule_id: "rule-1",
        workspace_id: "workspace-1",
        position: 0,
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-6",
        credential_alias: "default-anthropic",
        credential_id: null,
      },
      {
        rule_id: "rule-1",
        workspace_id: "workspace-1",
        position: 1,
        provider: "openai",
        model: "openai/gpt-4.1-mini",
        credential_alias: null,
        credential_id: "fallback-openai",
      },
    ]);
  });
});

describe("routing_rule allowlist contract", () => {
  // Regression guard for the bug class that hit credential.kind (fixed in
  // commit d1241c2) and routing_rule.provider (fixed by harper-server
  // migration 20260513150000): platform enum values silently drifted ahead
  // of the DB CHECK constraint. These tests fail at CI time if anyone adds
  // a runner_kind to RUNNER_KINDS or an execution provider to
  // KNOWN_EXECUTION_PROVIDER_IDS without also expanding the allowlist
  // mirror here (and the matching harper-server migration).

  it("every RUNNER_KINDS entry is in ROUTING_RULE_RUNNER_KIND_ALLOWED", () => {
    const missing = RUNNER_KINDS.filter((kind) => !ROUTING_RULE_RUNNER_KIND_ALLOWED.has(kind));
    expect(
      missing,
      `RUNNER_KINDS entries missing from the DB allowlist: ${missing.join(", ") || "(none)"}. ` +
        `Add them to ROUTING_RULE_RUNNER_KIND_ALLOWED here and to the harper-server ` +
        `routing_rule_runner_kind_check constraint in the same change.`,
    ).toEqual([]);
  });

  it("every KNOWN_EXECUTION_PROVIDER_IDS entry is in ROUTING_RULE_PROVIDER_ALLOWED", () => {
    const missing = KNOWN_EXECUTION_PROVIDER_IDS.filter((provider) => !ROUTING_RULE_PROVIDER_ALLOWED.has(provider));
    expect(
      missing,
      `KNOWN_EXECUTION_PROVIDER_IDS entries missing from the DB allowlist: ${missing.join(", ") || "(none)"}. ` +
        `Add them to ROUTING_RULE_PROVIDER_ALLOWED here and to the harper-server ` +
        `routing_rule_provider_check constraint in the same change.`,
    ).toEqual([]);
  });

  it("upsertAgentCredentialReferenceRule rejects an unknown runner_kind before hitting the DB", async () => {
    await expect(
      upsertAgentCredentialReferenceRule({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        runnerKind: "made_up_runner",
        provider: "openai",
        model: "openai/gpt-5.2",
        credentialRef: null,
      }),
    ).rejects.toThrow(/routing_rule\.runner_kind/);
  });

  it("upsertAgentCredentialReferenceRule rejects an unknown provider before hitting the DB", async () => {
    await expect(
      upsertAgentCredentialReferenceRule({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        runnerKind: "codex",
        provider: "made_up_provider",
        model: "openai/gpt-5.2",
        credentialRef: null,
      }),
    ).rejects.toThrow(/routing_rule\.provider/);
  });

  it("upsertAgentCredentialReferenceRule accepts a null provider (the constraint allows null)", async () => {
    // We don't care about success here — only that the guard doesn't
    // throw routing_rule.provider before the DB call is made. Force the
    // Supabase call to fail so we know we got past the guard.
    vi.mocked(getServiceRoleSupabase).mockImplementation(() => {
      throw new Error("supabase_called");
    });
    await expect(
      upsertAgentCredentialReferenceRule({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        runnerKind: "codex",
        provider: null,
        model: "openai/gpt-5.2",
        credentialRef: null,
      }),
    ).rejects.toThrow(/Repository operation failed|supabase_called/);
  });
});
