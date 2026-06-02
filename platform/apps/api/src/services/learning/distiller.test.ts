import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SupabaseClientModule from "../../supabase-client.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import { createMockSupabaseClient } from "../../test-utils/supabase-client-mock.js";
import { distillWorkspaceSkills } from "./distiller.js";

vi.mock("../../supabase-client.js", async () => {
  const actual = await vi.importActual<typeof SupabaseClientModule>("../../supabase-client.js");
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

vi.mock("../../logger.js", () => ({
  logEvent: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";

function memory(overrides: Record<string, unknown>) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: workspaceId,
    agent_id: null,
    canonical_id: null,
    content:
      "Scheduler delivery handling should branch on learning distillation kind and record candidate skill notes.",
    event_time: "2026-05-17T12:00:00.000Z",
    importance: 8,
    scope: "run_summary",
    source_path: null,
    source_run_id: "run-1",
    source_task_id: "task-1",
    supersedes_id: null,
    tags: {},
    created_at: "2026-05-17T12:00:00.000Z",
    updated_at: "2026-05-17T12:00:00.000Z",
    is_deleted: false,
    ...overrides,
  };
}

describe("learning distiller", () => {
  let tables: Record<string, Array<Record<string, unknown>>>;

  beforeEach(() => {
    vi.restoreAllMocks();
    tables = {
      workspaces: [
        {
          id: workspaceId,
          settings: {},
        },
      ],
      memory_items: [
        memory({ id: "22222222-2222-4222-8222-222222222222", source_run_id: "run-1" }),
        memory({
          id: "33333333-3333-4333-8333-333333333333",
          source_run_id: "run-2",
          content:
            "Learning distillation scheduled task delivery should branch on the delivery kind and create candidate skill records.",
        }),
        memory({
          id: "44444444-4444-4444-8444-444444444444",
          source_run_id: "run-old",
          event_time: "2026-04-01T12:00:00.000Z",
        }),
        memory({
          id: "55555555-5555-4555-8555-555555555555",
          source_run_id: "run-low",
          importance: 2,
        }),
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);
  });

  it("clusters recent important run summaries and stores candidate skill memories", async () => {
    const analyzer = vi.fn().mockResolvedValue({
      slug: "learning-distillation-delivery",
      title: "Learning Distillation Delivery",
      summary: "Handle learning distillation scheduled-task deliveries consistently.",
      body: "Use the scheduled-task delivery kind to route learning_distillation jobs into the distiller and store candidate skill memory rows for review.",
      confidence: 0.91,
    });

    const result = await distillWorkspaceSkills(workspaceId, 7, {
      analyzer,
      now: new Date("2026-05-18T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      consideredMemoryCount: 2,
      clusterCount: 1,
      candidateCount: 1,
    });
    expect(analyzer).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        memories: expect.arrayContaining([
          expect.objectContaining({ sourceRunId: "run-1" }),
          expect.objectContaining({ sourceRunId: "run-2" }),
        ]),
      }),
    );
    expect(tables.memory_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspaceId,
          scope: "run_summary",
          tags: expect.objectContaining({
            candidate_skill: true,
            skill_slug: "learning-distillation-delivery",
            source_run_ids: ["run-1", "run-2"],
          }),
        }),
      ]),
    );
  });

  it("does not write a candidate when the analyzer rejects a cluster", async () => {
    const result = await distillWorkspaceSkills(workspaceId, 7, {
      analyzer: vi.fn().mockResolvedValue(null),
      now: new Date("2026-05-18T12:00:00.000Z"),
    });

    expect(result.candidateCount).toBe(0);
    expect(tables.memory_items).toHaveLength(4);
  });
});
