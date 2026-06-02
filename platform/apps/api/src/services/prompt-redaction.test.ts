import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listSavedCredentialsForAgentFromSupabase,
  listSavedModelProviderCredentialsForWorkspaceFromSupabase,
} from "./saved-credentials.js";
import { resolveStoredCredentialSecret } from "./stored-credentials.js";
import { redactOutboundPromptForWorkspace, redactPromptCredentialSecrets } from "./prompt-redaction.js";

vi.mock("./saved-credentials.js", () => ({
  listSavedCredentialsForAgentFromSupabase: vi.fn(),
  listSavedModelProviderCredentialsForWorkspaceFromSupabase: vi.fn(),
}));

vi.mock("./stored-credentials.js", () => ({
  resolveStoredCredentialSecret: vi.fn(),
}));

describe("redactPromptCredentialSecrets", () => {
  it("replaces exact credential values with a redacted marker", () => {
    expect(
      redactPromptCredentialSecrets("Use sk-test-1234 for this check. sk-test-1234 must not leak.", ["sk-test-1234"]),
    ).toEqual({
      prompt: "Use <redacted> for this check. <redacted> must not leak.",
      redactionCount: 2,
    });
  });

  it("redacts longer overlapping secrets before shorter values", () => {
    expect(redactPromptCredentialSecrets("token sk-test-1234", ["sk-test", "sk-test-1234"])).toEqual({
      prompt: "token <redacted>",
      redactionCount: 1,
    });
  });

  it("ignores short values to avoid broad accidental rewrites", () => {
    expect(redactPromptCredentialSecrets("Use test in the prompt.", ["test"])).toEqual({
      prompt: "Use test in the prompt.",
      redactionCount: 0,
    });
  });
});

describe("redactOutboundPromptForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("loads agent and workspace credentials before redacting the prompt", async () => {
    const agentCredential = {
      secretValue: "sk-agent-1234",
      secretRef: null,
      aliases: ["OPENAI_API_KEY"],
    };
    const workspaceCredential = {
      secretValue: "",
      secretRef: "aws:secret",
      aliases: ["ANTHROPIC_API_KEY"],
    };
    vi.mocked(listSavedCredentialsForAgentFromSupabase).mockResolvedValue([agentCredential] as never);
    vi.mocked(listSavedModelProviderCredentialsForWorkspaceFromSupabase).mockResolvedValue([
      workspaceCredential,
    ] as never);
    vi.mocked(resolveStoredCredentialSecret)
      .mockResolvedValueOnce("sk-agent-1234")
      .mockResolvedValueOnce("sk-workspace-5678");

    await expect(
      redactOutboundPromptForWorkspace({
        prompt: "Compare sk-agent-1234 with sk-workspace-5678.",
        planningAgentId: "agent-1",
        workspaceId: "workspace-1",
        userId: "user-1",
      }),
    ).resolves.toEqual({
      prompt: "Compare <redacted> with <redacted>.",
      redactionCount: 2,
    });

    expect(listSavedCredentialsForAgentFromSupabase).toHaveBeenCalledWith("agent-1", "workspace-1");
    expect(listSavedModelProviderCredentialsForWorkspaceFromSupabase).toHaveBeenCalledWith("workspace-1", "user-1");
  });
});
