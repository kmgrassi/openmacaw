import { inspect } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCredential } from "./credential-resolver.js";
import type * as SupabaseClientModule from "../supabase-client.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";

vi.mock("../supabase-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SupabaseClientModule>();
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

const workspaceId = "22222222-2222-4222-8222-222222222222";
const credentialId = "33333333-3333-4333-8333-333333333333";

function setupMockDatabase() {
  const db = {
    credential: [
      {
        id: credentialId,
        agent_id: null,
        workspace_id: workspaceId,
        user_id: null,
        format: "api_key",
        provider: "openai",
        display_name: "openai",
        key_value: {
          OPENAI_API_KEY: "sk-live-secret",
          key_last4: "cret",
        },
        created_at: "2026-04-26T00:00:00.000Z",
        updated_at: "2026-04-26T00:00:00.000Z",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        agent_id: null,
        workspace_id: "99999999-9999-4999-8999-999999999999",
        user_id: null,
        format: "api_key",
        provider: "openai",
        display_name: "openai",
        key_value: {
          OPENAI_API_KEY: "sk-foreign-secret",
        },
        created_at: "2026-04-26T00:00:00.000Z",
        updated_at: "2026-04-26T00:00:00.000Z",
      },
    ],
    gateway_config: [
      {
        scope_type: "workspace",
        scope_id: workspaceId,
        version: 3,
        config_json: {
          credentials: {
            "default-openai": `credential:${credentialId}`,
          },
        },
      },
    ],
  };

  vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

  return db;
}

describe("resolveCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a workspace-scoped credential id into a short-lived credential", async () => {
    setupMockDatabase();

    const credential = await resolveCredential(`credential:${credentialId}`, workspaceId);

    expect(credential.toDispatchPayload()).toEqual({
      id: credentialId,
      workspaceId,
      provider: "openai",
      envVar: "OPENAI_API_KEY",
      value: "sk-live-secret",
      endpoint: null,
      apiVersion: null,
    });
  });

  it("resolves aliases from workspace gateway config", async () => {
    setupMockDatabase();

    const credential = await resolveCredential("alias:default-openai", workspaceId);

    expect(credential.id).toBe(credentialId);
    expect(credential.secretValue).toBe("sk-live-secret");
  });

  it("lets explicit aliases override gateway config aliases", async () => {
    setupMockDatabase();

    const credential = await resolveCredential("alias:override", workspaceId, {
      override: `credential:${credentialId}`,
    });

    expect(credential.id).toBe(credentialId);
  });

  it("redacts secret material from JSON and inspect output", async () => {
    setupMockDatabase();

    const credential = await resolveCredential(credentialId, workspaceId);

    expect(JSON.stringify(credential)).not.toContain("sk-live-secret");
    expect(inspect(credential)).not.toContain("sk-live-secret");
    expect(JSON.stringify(credential)).toContain("<redacted>");
  });

  it("does not resolve credentials from another workspace", async () => {
    setupMockDatabase();

    await expect(
      resolveCredential("credential:44444444-4444-4444-8444-444444444444", workspaceId),
    ).rejects.toMatchObject({
      code: "credential_not_found",
    });
  });
});
