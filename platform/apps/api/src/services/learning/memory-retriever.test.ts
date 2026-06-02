import { beforeEach, describe, expect, it, vi } from "vitest";

import { listWorkspaceModelProviderCredentialRows } from "../../repositories/credentials.js";
import { searchMemoryItemsHybrid } from "../../repositories/memory-items.js";
import { resolveStoredCredentialSecret } from "../stored-credentials.js";
import { retrieveRelevantMemories } from "./memory-retriever.js";

vi.mock("../../repositories/credentials.js", () => ({
  listWorkspaceModelProviderCredentialRows: vi.fn(),
}));

vi.mock("../../repositories/memory-items.js", () => ({
  searchMemoryItemsHybrid: vi.fn(),
}));

vi.mock("../stored-credentials.js", () => ({
  resolveStoredCredentialSecret: vi.fn(),
}));

const baseMemory = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  scope: "long_term" as const,
  tags: {},
  eventTime: "2026-05-18T12:00:00.000Z",
  sourceRunId: null,
  sourceTaskId: null,
};

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const otherAgentId = "33333333-3333-4333-8333-333333333333";

function memory(input: { id: string; agentId: string | null; content: string; importance: number; score: number }) {
  return {
    ...baseMemory,
    ...input,
  };
}

describe("memory retriever", () => {
  beforeEach(() => {
    vi.mocked(listWorkspaceModelProviderCredentialRows).mockReset();
    vi.mocked(searchMemoryItemsHybrid).mockReset();
    vi.mocked(resolveStoredCredentialSecret).mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
      ),
    );
  });

  it("retrieves own-agent and workspace memories by default, excluding other agents", async () => {
    vi.mocked(listWorkspaceModelProviderCredentialRows).mockResolvedValue([]);
    vi.mocked(searchMemoryItemsHybrid)
      .mockResolvedValueOnce([
        memory({
          id: "own-memory",
          agentId,
          content: "This agent uses pnpm.",
          importance: 7,
          score: 0.7,
        }),
      ])
      .mockResolvedValueOnce([
        memory({
          id: "workspace-memory",
          agentId: null,
          content: "The workspace uses Supabase migrations.",
          importance: 9,
          score: 0.9,
        }),
        memory({
          id: "other-agent-memory",
          agentId: otherAgentId,
          content: "Other agent private note.",
          importance: 10,
          score: 1,
        }),
      ]);

    const result = await retrieveRelevantMemories({
      workspaceId,
      agentId,
      queryText: "package manager migrations",
      limit: 5,
    });

    expect(result.embeddingUsed).toBe(false);
    expect(result.results.map((item) => item.id)).toEqual(["workspace-memory", "own-memory"]);
    expect(searchMemoryItemsHybrid).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId,
        agentId,
        queryEmbedding: null,
      }),
    );
    expect(searchMemoryItemsHybrid).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId,
        queryEmbedding: null,
      }),
    );
  });

  it("narrows agent scope to only requesting-agent memories", async () => {
    vi.mocked(listWorkspaceModelProviderCredentialRows).mockResolvedValue([]);
    vi.mocked(searchMemoryItemsHybrid).mockResolvedValue([
      memory({
        id: "own-memory",
        agentId,
        content: "Agent-only memory.",
        importance: 5,
        score: 0.5,
      }),
    ]);

    const result = await retrieveRelevantMemories({
      workspaceId,
      agentId,
      queryText: "agent note",
      scope: "agent",
    });

    expect(result.results.map((item) => item.id)).toEqual(["own-memory"]);
    expect(searchMemoryItemsHybrid).toHaveBeenCalledTimes(1);
    expect(searchMemoryItemsHybrid).toHaveBeenCalledWith(expect.objectContaining({ agentId }));
  });

  it("uses workspace OpenAI credentials for embeddings when available", async () => {
    vi.mocked(listWorkspaceModelProviderCredentialRows).mockResolvedValue([
      {
        id: "credential-1",
        workspace_id: workspaceId,
        user_id: null,
        agent_id: null,
        format: "api_key",
        provider: "openai",
        display_name: "OpenAI",
        key_value: { secret_ref: "secret/openai" },
        updated_at: "2026-05-18T12:00:00.000Z",
        validated_at: null,
        validation_state: "ok",
      },
    ]);
    vi.mocked(resolveStoredCredentialSecret).mockResolvedValue("openai-key");
    vi.mocked(searchMemoryItemsHybrid).mockResolvedValue([]);

    const result = await retrieveRelevantMemories({
      workspaceId,
      agentId,
      queryText: "semantic search",
    });

    expect(result.embeddingUsed).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer openai-key" }),
      }),
    );
    expect(searchMemoryItemsHybrid).toHaveBeenCalledWith(expect.objectContaining({ queryEmbedding: "[0.1,0.2,0.3]" }));
  });

  it("filters by minimum importance and token budget after ranking", async () => {
    vi.mocked(listWorkspaceModelProviderCredentialRows).mockResolvedValue([]);
    vi.mocked(searchMemoryItemsHybrid)
      .mockResolvedValueOnce([
        memory({
          id: "high",
          agentId,
          content: "A".repeat(80),
          importance: 9,
          score: 0.9,
        }),
        memory({
          id: "low",
          agentId,
          content: "Low importance",
          importance: 2,
          score: 0.8,
        }),
        memory({
          id: "too-large",
          agentId,
          content: "B".repeat(200),
          importance: 10,
          score: 0.7,
        }),
      ])
      .mockResolvedValueOnce([]);

    const result = await retrieveRelevantMemories({
      workspaceId,
      agentId,
      queryText: "budget",
      importanceMin: 5,
      maxTokens: 30,
    });

    expect(result.results.map((item) => item.id)).toEqual(["high"]);
  });
});
