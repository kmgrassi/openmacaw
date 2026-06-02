import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase-client.js", async () => {
  const actual = await vi.importActual("../supabase-client.js");
  return {
    ...(actual as object),
    getUserScopedSupabase: vi.fn(),
  };
});

const { getUserScopedSupabase } = vi.mocked(await import("../supabase-client.js"));
const { resolveContainerDispatchResources } = await import("./resource-dispatch-resolution.js");

const accessToken = "test-token";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const platformGrantId = "44444444-4444-4444-8444-444444444444";
const platformResourceId = "55555555-5555-4555-8555-555555555555";
const runtimeGrantId = "66666666-6666-4666-8666-666666666666";
const runtimeResourceId = "77777777-7777-4777-8777-777777777777";

type ResourceGrantRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  resource_id: string;
  access_mode: "read" | "write";
  allowed_refs_json: unknown;
  network_policy_json: unknown;
  expires_at: string | null;
  revoked_at: string | null;
  workspace_resource: {
    id: string;
    workspace_id: string;
    resource_type: string;
    provider: string;
    provider_url: string;
    display_name: string | null;
    deleted_at: string | null;
    metadata_json: unknown;
    workspace_resource_credential?: Array<{
      credential_id: string;
      credential_purpose: string | null;
      revoked_at: string | null;
    }>;
  };
};

function grantRow(overrides: Partial<ResourceGrantRow> = {}): ResourceGrantRow {
  const resource = overrides.workspace_resource;
  return {
    id: platformGrantId,
    workspace_id: workspaceId,
    agent_id: agentId,
    resource_id: platformResourceId,
    access_mode: "read",
    allowed_refs_json: null,
    network_policy_json: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
    workspace_resource: {
      id: overrides.resource_id ?? platformResourceId,
      workspace_id: workspaceId,
      resource_type: "git_repository",
      provider: "github",
      provider_url: "https://github.com/kmgrassi/parallel-agent-platform.git",
      display_name: "parallel-agent-platform",
      deleted_at: null,
      metadata_json: {},
      workspace_resource_credential: [],
      ...resource,
    },
  };
}

function mockGrantRows(rows: ResourceGrantRow[]) {
  const builder = {
    eq: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    then: vi.fn((resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data: rows, error: null })),
  };
  builder.from.mockReturnValue(builder);
  getUserScopedSupabase.mockReturnValue(builder as never);
  return builder;
}

function fallbackNetworkPolicy() {
  return {
    mode: "allowlist" as const,
    allowedHosts: ["github.com"],
  };
}

describe("resolveContainerDispatchResources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves multiple requested repository grants into one dispatch resource list", async () => {
    const rows = [
      grantRow({
        allowed_refs_json: ["refs/heads/main"],
        workspace_resource: {
          id: platformResourceId,
          workspace_id: workspaceId,
          resource_type: "git_repository",
          provider: "github",
          provider_url: "https://github.com/kmgrassi/parallel-agent-platform.git",
          display_name: "parallel-agent-platform",
          deleted_at: null,
          metadata_json: {},
          workspace_resource_credential: [
            {
              credential_id: "88888888-8888-4888-8888-888888888888",
              credential_purpose: "git_clone",
              revoked_at: null,
            },
          ],
        },
      }),
      grantRow({
        id: runtimeGrantId,
        resource_id: runtimeResourceId,
        workspace_resource: {
          id: runtimeResourceId,
          workspace_id: workspaceId,
          resource_type: "git_repository",
          provider: "github",
          provider_url: "https://github.com/kmgrassi/parallel-agent-runtime.git",
          display_name: "parallel-agent-runtime",
          deleted_at: null,
          metadata_json: {},
          workspace_resource_credential: [],
        },
      }),
    ];
    mockGrantRows(rows);

    const resources = await resolveContainerDispatchResources({
      accessToken,
      workspaceId,
      agentId,
      fallbackNetworkPolicy: fallbackNetworkPolicy(),
      dispatchMetadata: {
        resources: [
          {
            resourceId: platformResourceId,
            alias: "platform",
            repositoryRef: {
              type: "git_ref",
              ref: "refs/heads/main",
            },
          },
          {
            grantId: runtimeGrantId,
            alias: "runtime",
            requirement: "optional",
          },
        ],
      },
    });

    expect(resources).toMatchObject([
      {
        grantId: platformGrantId,
        resourceId: platformResourceId,
        providerUrl: "https://github.com/kmgrassi/parallel-agent-platform.git",
        alias: "platform",
        credentialRef: {
          type: "credential_id",
          value: "88888888-8888-4888-8888-888888888888",
        },
        repositoryRef: {
          type: "git_ref",
          ref: "refs/heads/main",
        },
      },
      {
        grantId: runtimeGrantId,
        resourceId: runtimeResourceId,
        providerUrl: "https://github.com/kmgrassi/parallel-agent-runtime.git",
        alias: "runtime",
        requirement: "optional",
      },
    ]);
    expect(getUserScopedSupabase).toHaveBeenCalledWith(accessToken);
  });

  it("rejects a requested resource that has no active grant", async () => {
    mockGrantRows([grantRow()]);

    await expect(
      resolveContainerDispatchResources({
        accessToken,
        workspaceId,
        agentId,
        fallbackNetworkPolicy: fallbackNetworkPolicy(),
        dispatchMetadata: {
          resources: [
            {
              resourceId: runtimeResourceId,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "resource_not_granted",
    });
  });

  it("rejects write access when the grant is read-only", async () => {
    mockGrantRows([grantRow()]);

    await expect(
      resolveContainerDispatchResources({
        accessToken,
        workspaceId,
        agentId,
        fallbackNetworkPolicy: fallbackNetworkPolicy(),
        dispatchMetadata: {
          resources: [
            {
              resourceId: platformResourceId,
              accessMode: "write",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "resource_access_mode_not_granted",
    });
  });

  it("rejects a ref-restricted grant when no repository ref is requested", async () => {
    mockGrantRows([
      grantRow({
        allowed_refs_json: ["refs/heads/main"],
      }),
    ]);

    await expect(
      resolveContainerDispatchResources({
        accessToken,
        workspaceId,
        agentId,
        fallbackNetworkPolicy: fallbackNetworkPolicy(),
        dispatchMetadata: {
          resources: [
            {
              resourceId: platformResourceId,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "resource_ref_not_granted",
    });
  });

  it("uses all active grants when the request does not narrow resources", async () => {
    mockGrantRows([
      grantRow({
        workspace_resource: {
          id: platformResourceId,
          workspace_id: workspaceId,
          resource_type: "git_repository",
          provider: "github",
          provider_url: "https://github.com/kmgrassi/parallel-agent-platform.git",
          display_name: null,
          deleted_at: null,
          metadata_json: {},
          workspace_resource_credential: [],
        },
      }),
    ]);

    const resources = await resolveContainerDispatchResources({
      accessToken,
      workspaceId,
      agentId,
      fallbackNetworkPolicy: fallbackNetworkPolicy(),
      dispatchMetadata: {},
    });

    expect(resources).toMatchObject([
      {
        resourceId: platformResourceId,
        alias: "parallel-agent-platform",
        accessMode: "read",
        requirement: "required",
      },
    ]);
  });

  it("skips inactive grants when defaulting to all resources", async () => {
    mockGrantRows([
      grantRow({
        revoked_at: "2026-05-01T00:00:00.000Z",
      }),
      grantRow({
        id: runtimeGrantId,
        resource_id: runtimeResourceId,
        workspace_resource: {
          id: runtimeResourceId,
          workspace_id: workspaceId,
          resource_type: "git_repository",
          provider: "github",
          provider_url: "https://github.com/kmgrassi/parallel-agent-runtime.git",
          display_name: "parallel-agent-runtime",
          deleted_at: null,
          metadata_json: {},
          workspace_resource_credential: [],
        },
      }),
    ]);

    const resources = await resolveContainerDispatchResources({
      accessToken,
      workspaceId,
      agentId,
      fallbackNetworkPolicy: fallbackNetworkPolicy(),
      dispatchMetadata: {},
    });

    expect(resources).toMatchObject([
      {
        resourceId: runtimeResourceId,
        alias: "parallel-agent-runtime",
      },
    ]);
  });
});
