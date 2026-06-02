import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { workspaceHasEmbeddedMemories } from "./learning-memory.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
}));

describe("learning memory repository", () => {
  beforeEach(() => {
    vi.mocked(getServiceRoleSupabase).mockReset();
  });

  it("returns true when the workspace has a non-deleted embedded memory", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        memory_items: [
          {
            id: "memory-1",
            workspace_id: "workspace-1",
            is_deleted: false,
            embedding: "[0.1,0.2]",
          },
        ],
      }) as never,
    );

    await expect(workspaceHasEmbeddedMemories("workspace-1")).resolves.toBe(true);
  });

  it("ignores deleted memories and memories without embeddings", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        memory_items: [
          {
            id: "memory-1",
            workspace_id: "workspace-1",
            is_deleted: false,
            embedding: null,
          },
          {
            id: "memory-2",
            workspace_id: "workspace-1",
            is_deleted: true,
            embedding: "[0.1,0.2]",
          },
        ],
      }) as never,
    );

    await expect(workspaceHasEmbeddedMemories("workspace-1")).resolves.toBe(false);
  });
});
