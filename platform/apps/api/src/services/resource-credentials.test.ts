import { describe, expect, it, vi } from "vitest";

import { getCredentialRowByIdForWorkspace } from "../repositories/credentials.js";
import { resolveSecretReference } from "../secrets.js";
import { mintGitHubInstallationToken } from "./resource-credentials.js";

vi.mock("jsonwebtoken", () => ({
  default: {
    sign: vi.fn(() => "signed-app-jwt"),
  },
}));

vi.mock("../repositories/credentials.js", () => ({
  getCredentialRowByIdForWorkspace: vi.fn(),
}));

vi.mock("../secrets.js", () => ({
  resolveSecretReference: vi.fn(),
}));

describe("GitHub App resource credentials", () => {
  it("mints an installation token from a stored GitHub App credential without exposing it via JSON", async () => {
    vi.mocked(getCredentialRowByIdForWorkspace).mockResolvedValue({
      id: "credential-1",
      agent_id: null,
      workspace_id: "workspace-1",
      user_id: "user-1",
      format: "github_app_installation",
      provider: "github",
      display_name: "GitHub App",
      key_value: {
        provider: "github",
        app_id: "123",
        installation_id: "456",
        api_base_url: "https://api.github.test",
        web_base_url: "https://github.test",
        private_key_secret_ref: "secret/github-app",
      },
      updated_at: "2026-05-19T00:00:00.000Z",
      validated_at: null,
      validation_state: "unknown",
    });
    vi.mocked(resolveSecretReference).mockResolvedValue("mock-github-app-private-key");
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          token: "ghs_secret_installation_token",
          expires_at: "2026-05-19T01:00:00Z",
          permissions: { contents: "read" },
          repository_selection: "selected",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const token = await mintGitHubInstallationToken({
      workspaceId: "workspace-1",
      credentialId: "credential-1",
      fetchFn,
      nowMs: Date.parse("2026-05-19T00:00:00Z"),
    });

    expect(token.tokenValue).toBe("ghs_secret_installation_token");
    expect(JSON.stringify(token)).not.toContain("ghs_secret_installation_token");
    expect(JSON.stringify(token)).toContain("[redacted]");
    expect(resolveSecretReference).toHaveBeenCalledWith("secret/github-app", ["private_key", "GITHUB_APP_PRIVATE_KEY"]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.github.test/app/installations/456/access_tokens",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer signed-app-jwt",
        }),
      }),
    );
  });
});
