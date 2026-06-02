import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServiceRoleSupabase } from "../supabase-client.js";
import { credentialKeyFromRecord, type CredentialKey } from "../../../../contracts/credentials.js";
import {
  createAgentCredential,
  createWorkspaceModelProviderCredential,
  credentialDisplayName,
  deleteCredentialAlias,
  isValidCredentialAlias,
  listAgentCredentialRows,
  listCredentialAgentIds,
  listCredentialAliases,
  normalizeCredentialAlias,
  resolveCredentialAlias,
  upsertCredentialAlias,
} from "./credentials.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

type MockFn = ReturnType<typeof vi.fn>;
type QueryBuilder = {
  delete: MockFn;
  eq: MockFn;
  in: MockFn;
  insert: MockFn;
  maybeSingle: MockFn;
  order: MockFn;
  range: MockFn;
  select: MockFn;
  single: MockFn;
  upsert: MockFn;
  then?: MockFn;
};

function mockBuilder(result: unknown): QueryBuilder {
  const builder: QueryBuilder = {
    delete: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    insert: vi.fn(),
    maybeSingle: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
    upsert: vi.fn(),
  };

  builder.delete.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  builder.insert.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.range.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.upsert.mockReturnValue(builder);
  builder.maybeSingle.mockResolvedValue(result);
  builder.single.mockResolvedValue(result);
  builder.then = vi.fn((resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)));

  return builder;
}

function useBuilder(builder: QueryBuilder) {
  const from = vi.fn().mockReturnValue(builder);
  vi.mocked(getServiceRoleSupabase).mockReturnValue({ from } as never);
  return from;
}

describe("credential alias repository", () => {
  beforeEach(() => {
    vi.mocked(getServiceRoleSupabase).mockReset();
  });

  it("normalizes and validates workspace credential aliases", () => {
    expect(normalizeCredentialAlias(" Default-Claude ")).toBe("default-claude");
    expect(isValidCredentialAlias("default-claude")).toBe(true);
    expect(isValidCredentialAlias("personal_llama")).toBe(true);
    expect(isValidCredentialAlias("Uppercase")).toBe(true);
    expect(isValidCredentialAlias("-bad")).toBe(false);
    expect(isValidCredentialAlias("bad.alias")).toBe(false);
    expect(isValidCredentialAlias("")).toBe(false);
    expect(isValidCredentialAlias("a".repeat(65))).toBe(false);
  });

  it("lists aliases scoped to a workspace", async () => {
    const rows = [
      {
        workspace_id: "workspace-1",
        alias: "default-openai",
        credential_id: "credential-1",
        created_at: "2026-04-26T12:00:00.000Z",
        updated_at: "2026-04-26T12:00:00.000Z",
      },
    ];
    const builder = mockBuilder({ data: rows, error: null });
    const from = useBuilder(builder);

    await expect(listCredentialAliases("workspace-1")).resolves.toHaveLength(1);

    expect(from).toHaveBeenCalledWith("credential_alias");
    expect(builder.select).toHaveBeenCalledWith("workspace_id,alias,credential_id,created_at");
    expect(builder.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(builder.order).toHaveBeenCalledWith("alias", { ascending: true });
  });

  it("resolves normalized aliases", async () => {
    const row = {
      workspace_id: "workspace-1",
      alias: "default-openai",
      credential_id: "credential-1",
      created_at: "2026-04-26T12:00:00.000Z",
      updated_at: "2026-04-26T12:00:00.000Z",
    };
    const builder = mockBuilder({ data: row, error: null });
    useBuilder(builder);

    await expect(resolveCredentialAlias("workspace-1", " Default-OpenAI ")).resolves.toMatchObject({
      alias: "default-openai",
      credential_id: "credential-1",
    });

    expect(builder.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(builder.eq).toHaveBeenCalledWith("alias", "default-openai");
    expect(builder.maybeSingle).toHaveBeenCalled();
  });

  it("upserts normalized aliases by workspace and alias", async () => {
    const row = {
      workspace_id: "workspace-1",
      alias: "default-openai",
      credential_id: "credential-1",
      created_at: "2026-04-26T12:00:00.000Z",
      updated_at: "2026-04-26T12:00:00.000Z",
    };
    const builder = mockBuilder({ data: row, error: null });
    useBuilder(builder);

    await expect(
      upsertCredentialAlias({
        workspaceId: "workspace-1",
        alias: " Default-OpenAI ",
        credentialId: "credential-1",
      }),
    ).resolves.toMatchObject({ alias: "default-openai" });

    expect(builder.upsert).toHaveBeenCalledWith(
      {
        workspace_id: "workspace-1",
        alias: "default-openai",
        credential_id: "credential-1",
      },
      { onConflict: "workspace_id,alias" },
    );
    expect(builder.single).toHaveBeenCalled();
  });

  it("deletes aliases by workspace and normalized alias", async () => {
    const builder = mockBuilder({ data: [], error: null });
    useBuilder(builder);

    await expect(deleteCredentialAlias({ workspaceId: "workspace-1", alias: " Default-OpenAI " })).resolves.toEqual([]);

    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(builder.eq).toHaveBeenCalledWith("alias", "default-openai");
  });
});

describe("listCredentialAgentIds", () => {
  beforeEach(() => {
    vi.mocked(getServiceRoleSupabase).mockReset();
  });

  it("queries credential.agent_id directly", async () => {
    const builder = mockBuilder({
      data: [{ agent_id: "agent-1" }, { agent_id: "agent-2" }, { agent_id: null }],
      error: null,
    });
    const from = useBuilder(builder);

    await expect(listCredentialAgentIds(["agent-1", "agent-2"])).resolves.toEqual(new Set(["agent-1", "agent-2"]));

    expect(from).toHaveBeenCalledWith("credential");
    expect(builder.select).toHaveBeenCalledWith("agent_id");
    expect(builder.in).toHaveBeenCalledWith("agent_id", ["agent-1", "agent-2"]);
    expect(builder.range).not.toHaveBeenCalled();
  });

  it("returns empty set when no agent ids requested", async () => {
    await expect(listCredentialAgentIds([])).resolves.toEqual(new Set());
  });

  it("surfaces underlying Supabase errors instead of swallowing them", async () => {
    const builder = mockBuilder({
      data: null,
      error: new Error("permission denied for table credential"),
    });
    useBuilder(builder);

    await expect(listCredentialAgentIds(["agent-1"])).rejects.toMatchObject({
      code: "repository_operation_error",
      cause: expect.objectContaining({ message: "permission denied for table credential" }),
      details: expect.objectContaining({
        repository: "credentials",
        method: "listCredentialAgentIds",
        table: "credential",
      }),
    });
  });
});

describe("listAgentCredentialRows", () => {
  beforeEach(() => {
    vi.mocked(getServiceRoleSupabase).mockReset();
  });

  it("queries workspace and agent credentials directly", async () => {
    const matchingRow = {
      id: "credential-2",
      agent_id: "agent-on-second-page",
      workspace_id: "workspace-1",
      user_id: "user-1",
      format: "api_key",
      provider: "openai",
      display_name: "openai",
      key_value: { OPENAI_API_KEY: "sk-test" },
      updated_at: "2026-04-28T00:00:00.000Z",
      validated_at: null,
      validation_state: "unknown",
    };
    const builder = mockBuilder({
      data: [matchingRow],
      error: null,
    });
    const from = useBuilder(builder);

    await expect(listAgentCredentialRows("agent-on-second-page", "workspace-1")).resolves.toEqual([matchingRow]);

    expect(from).toHaveBeenCalledWith("credential");
    expect(builder.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(builder.eq).toHaveBeenCalledWith("agent_id", "agent-on-second-page");
    expect(builder.range).not.toHaveBeenCalled();
  });
});

describe("credential key persistence invariants", () => {
  beforeEach(() => {
    vi.mocked(getServiceRoleSupabase).mockReset();
  });

  const credentialKeys: CredentialKey[] = [
    { format: "api_key", provider: "openai", secret: "sk-openai" },
    {
      format: "oauth",
      provider: "openai_codex",
      access: "access-token",
      refresh: "refresh-token",
      expiresAt: 1_800_000_000_000,
      identity: { email: "kg@example.com" },
    },
    { format: "secret_ref", provider: "anthropic", secretRef: "secret/anthropic" },
    {
      format: "compatible_endpoint",
      provider: "openai_compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      secret: null,
    },
  ];

  it("round-trips every CredentialKey shape through save and read with matching provider and format columns", async () => {
    for (const credentialKey of credentialKeys) {
      let inserted: Record<string, unknown> | null = null;
      const builder = mockBuilder({ data: null, error: null });
      builder.insert.mockImplementation((row: Record<string, unknown>) => {
        inserted = row;
        return builder;
      });
      builder.single.mockImplementation(async () => ({
        data: {
          id: `credential-${credentialKey.format}`,
          created_at: "2026-04-28T00:00:00.000Z",
          updated_at: "2026-04-28T00:00:00.000Z",
          display_name: "credential",
          ...(inserted ?? {}),
        },
        error: null,
      }));
      useBuilder(builder);

      const row = await createAgentCredential({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        credentialKey,
      });

      expect(row?.format).toBe(credentialKey.format);
      expect(row?.provider).toBe(credentialKey.provider);
      const raw =
        row?.key_value && typeof row.key_value === "object" && !Array.isArray(row.key_value)
          ? (row.key_value as Record<string, unknown>)
          : null;
      expect(raw).not.toBeNull();
      const parsed = credentialKeyFromRecord({ ...(raw ?? {}), provider: row?.provider });
      expect(parsed?.format).toBe(credentialKey.format);
      expect(parsed?.provider).toBe(credentialKey.provider);
    }
  });

  it("derives workspace credential rows from the same CredentialKey contract", async () => {
    let inserted: Record<string, unknown> | null = null;
    const builder = mockBuilder({ data: null, error: null });
    builder.insert.mockImplementation((row: Record<string, unknown>) => {
      inserted = row;
      return builder;
    });
    builder.single.mockImplementation(async () => ({
      data: {
        id: "credential-workspace",
        created_at: "2026-04-28T00:00:00.000Z",
        updated_at: "2026-04-28T00:00:00.000Z",
        display_name: "credential",
        ...(inserted ?? {}),
      },
      error: null,
    }));
    useBuilder(builder);

    const credentialKey: CredentialKey = { format: "api_key", provider: "openai", secret: "sk-workspace" };
    const row = await createWorkspaceModelProviderCredential({
      workspaceId: "workspace-1",
      userId: "user-1",
      credentialKey,
    });

    expect(row?.format).toBe("api_key");
    expect(row?.provider).toBe("openai");
    expect(row?.key_value).toMatchObject({ provider: "openai", OPENAI_API_KEY: "sk-workspace" });
  });
});

describe("credentialDisplayName", () => {
  it("uses ChatGPT (email) for OAuth credentials when email is present", () => {
    expect(
      credentialDisplayName({
        format: "oauth",
        provider: "openai_codex",
        access: "tok",
        refresh: "refresh",
        expiresAt: 1_800_000_000_000,
        identity: { email: "kg@example.com" },
      }),
    ).toBe("ChatGPT (kg@example.com)");
  });

  it("falls back to 'ChatGPT' for OAuth credentials without email", () => {
    expect(
      credentialDisplayName({
        format: "oauth",
        provider: "openai_codex",
        access: "tok",
        refresh: "refresh",
        expiresAt: 1_800_000_000_000,
      }),
    ).toBe("ChatGPT");
  });

  it("uses the provider for non-OAuth credentials", () => {
    expect(credentialDisplayName({ format: "api_key", provider: "openai", secret: "sk" })).toBe("openai");
  });
});
