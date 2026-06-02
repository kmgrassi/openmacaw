import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAgentCredential,
  createWorkspaceModelProviderCredential,
  listAgentCredentialRows,
  listWorkspaceModelProviderCredentialRows,
  updateCredentialKeyValue,
} from "../repositories/credentials.js";
import { saveModelProviderCredentialForWorkspaceInSupabase } from "./saved-credentials.js";

vi.mock("../repositories/credentials.js", () => ({
  createAgentCredential: vi.fn(),
  createWorkspaceModelProviderCredential: vi.fn(),
  listAgentCredentialRows: vi.fn(),
  listWorkspaceModelProviderCredentialRows: vi.fn(),
  updateCredentialKeyValue: vi.fn(),
}));

describe("saveModelProviderCredentialForWorkspaceInSupabase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAgentCredentialRows).mockResolvedValue([]);
    vi.mocked(createAgentCredential).mockResolvedValue(null);
    vi.mocked(updateCredentialKeyValue).mockResolvedValue(null);
  });

  it("returns the mapped workspace credential after creating a typed CredentialKey row", async () => {
    vi.mocked(listWorkspaceModelProviderCredentialRows).mockResolvedValue([]);
    vi.mocked(createWorkspaceModelProviderCredential).mockResolvedValue({
      id: "credential-1",
      agent_id: null,
      created_at: "2026-05-14T00:00:00.000Z",
      format: "api_key",
      provider: "openai",
      workspace_id: "workspace-1",
      user_id: "user-1",
      display_name: "openai",
      validation_state: "unknown",
      validated_at: null,
      key_value: {
        provider: "openai",
        OPENAI_API_KEY: "sk-test-secret",
        key_last4: "cret",
      },
      updated_at: "2026-05-14T00:00:00.000Z",
    });

    const saved = await saveModelProviderCredentialForWorkspaceInSupabase({
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "openai",
      apiKey: "sk-test-secret",
    });

    expect(createWorkspaceModelProviderCredential).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      credentialKey: {
        format: "api_key",
        provider: "openai",
        secret: "sk-test-secret",
      },
    });
    expect(saved).toMatchObject({
      credentialRowId: "credential-1",
      workspaceId: "workspace-1",
      provider: "openai",
      envVar: "OPENAI_API_KEY",
      secretValue: "sk-test-secret",
    });
  });
});
