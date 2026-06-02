import { describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../../test-utils/supabase-client-mock.js";
import { buildPinnedMemoryPromptBlock } from "./pinned-memory.js";

vi.mock("../../logger.js", () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  logEvent: vi.fn(),
}));

const agentId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("pinned memory prompt block", () => {
  it("returns no block when learning is disabled", async () => {
    const block = await buildPinnedMemoryPromptBlock({
      agentId,
      workspaceId,
      supabase: createMockSupabaseClient({
        agent: [{ id: agentId, workspace_id: workspaceId, tool_policy: {} }],
        workspaces: [{ id: workspaceId, settings: { learning: { enabled: false } } }],
      }) as never,
    });

    expect(block).toBeNull();
  });

  it("formats up to three long-term memories by importance", async () => {
    const block = await buildPinnedMemoryPromptBlock({
      agentId,
      workspaceId,
      sessionId: "session-1",
      supabase: createMockSupabaseClient({
        agent: [{ id: agentId, workspace_id: workspaceId, tool_policy: {} }],
        workspaces: [{ id: workspaceId, settings: { learning: { enabled: true } } }],
        memory_items: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            workspace_id: workspaceId,
            agent_id: null,
            content: "This repo uses pnpm, not npm.",
            importance: 9,
            scope: "long_term",
            tags: {},
            source_run_id: null,
            source_task_id: null,
            source_path: null,
            canonical_id: null,
            supersedes_id: null,
            event_time: "2026-04-25T00:00:00.000Z",
            is_deleted: false,
            created_at: "2026-04-25T00:00:00.000Z",
            updated_at: "2026-04-25T00:00:00.000Z",
          },
          {
            id: "66666666-6666-4666-8666-666666666666",
            workspace_id: workspaceId,
            agent_id: agentId,
            content: "Validation requires the API and web typechecks.",
            importance: 8,
            scope: "long_term",
            tags: {},
            source_run_id: null,
            source_task_id: null,
            source_path: null,
            canonical_id: null,
            supersedes_id: null,
            event_time: "2026-04-25T00:00:00.000Z",
            is_deleted: false,
            created_at: "2026-04-25T00:00:00.000Z",
            updated_at: "2026-04-25T00:00:00.000Z",
          },
        ],
      }) as never,
    });

    expect(block).toContain("## Workspace memory (pinned)");
    expect(block).toContain("- (importance 9) This repo uses pnpm, not npm.");
    expect(block).toContain("- (importance 8) Validation requires the API and web typechecks.");
  });
});
