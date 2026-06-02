import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SupabaseClientModule from "../../supabase-client.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import { createMockSupabaseClient } from "../../test-utils/supabase-client-mock.js";
import { openSkillCandidatePullRequest, resolveWorkspaceRepository } from "./skill-candidate-pr-bot.js";

vi.mock("../../supabase-client.js", async () => {
  const actual = await vi.importActual<typeof SupabaseClientModule>("../../supabase-client.js");
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

const workspaceId = "11111111-1111-4111-8111-111111111111";
const candidateMemoryId = "22222222-2222-4222-8222-222222222222";
const sourceMemoryId = "33333333-3333-4333-8333-333333333333";

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: candidateMemoryId,
    workspace_id: workspaceId,
    content: "Always run `pnpm -C apps/api run validate` before publishing API changes.",
    scope: "run_summary",
    source_run_id: "run-1",
    source_task_id: "task-1",
    tags: {
      candidate_skill: true,
      skill_title: "API validation workflow",
      source_memory_ids: [sourceMemoryId],
    },
    is_deleted: false,
    ...overrides,
  };
}

describe("resolveWorkspaceRepository", () => {
  it("uses the single repository bound to the workspace", () => {
    expect(
      resolveWorkspaceRepository({
        workspaceId,
        githubRepoWorkspaceMap: { "kmgrassi/parallel-agent-platform": workspaceId },
      }),
    ).toBe("kmgrassi/parallel-agent-platform");
  });

  it("rejects repositories not bound to the workspace", () => {
    expect(() =>
      resolveWorkspaceRepository({
        workspaceId,
        requestedRepository: "other/repo",
        githubRepoWorkspaceMap: { "kmgrassi/parallel-agent-platform": workspaceId },
      }),
    ).toThrow("Requested repository is not bound to the workspace");
  });
});

describe("openSkillCandidatePullRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a branch, writes the skill file, and opens a ready PR", async () => {
    const tables = {
      memory_items: [
        memoryRow(),
        memoryRow({
          id: sourceMemoryId,
          content: "The API validation command catches format, lint, typecheck, and test regressions.",
          source_run_id: "run-2",
          source_task_id: null,
          tags: {},
        }),
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.github.com", "");
      if (path === "/repos/kmgrassi/parallel-agent-platform") {
        return Response.json({ default_branch: "main" });
      }
      if (path === "/repos/kmgrassi/parallel-agent-platform/git/ref/heads/main") {
        return Response.json({ object: { sha: "base-sha" } });
      }
      if (path === "/repos/kmgrassi/parallel-agent-platform/git/refs") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          ref: `refs/heads/codex/skill-candidate-api-validation-workflow-${candidateMemoryId.slice(0, 8)}`,
          sha: "base-sha",
        });
        return Response.json({ ref: "created" });
      }
      if (path === "/repos/kmgrassi/parallel-agent-platform/contents/.codex/skills/api-validation-workflow.md") {
        expect(init?.method).toBe("PUT");
        const body = JSON.parse(String(init?.body));
        expect(body.branch).toBe(`codex/skill-candidate-api-validation-workflow-${candidateMemoryId.slice(0, 8)}`);
        expect(Buffer.from(body.content, "base64").toString("utf8")).toContain("# API validation workflow");
        return Response.json({ content: { path: ".codex/skills/api-validation-workflow.md" } });
      }
      if (path === "/repos/kmgrassi/parallel-agent-platform/pulls") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body.draft).toBe(false);
        expect(body.body).toContain(`memory \`${candidateMemoryId}\``);
        expect(body.body).toContain("source run `run-2`");
        return Response.json({ html_url: "https://github.com/kmgrassi/parallel-agent-platform/pull/123", number: 123 });
      }
      throw new Error(`Unexpected GitHub request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openSkillCandidatePullRequest({
        workspaceId,
        request: { candidateMemoryId },
        config: {
          githubApiToken: "token",
          githubRepoWorkspaceMap: { "kmgrassi/parallel-agent-platform": workspaceId },
        },
      }),
    ).resolves.toEqual({
      candidateMemoryId,
      sourceMemoryIds: [candidateMemoryId, sourceMemoryId],
      pullRequest: {
        url: "https://github.com/kmgrassi/parallel-agent-platform/pull/123",
        number: 123,
        repository: "kmgrassi/parallel-agent-platform",
        branch: `codex/skill-candidate-api-validation-workflow-${candidateMemoryId.slice(0, 8)}`,
        baseBranch: "main",
        skillPath: ".codex/skills/api-validation-workflow.md",
      },
    });
  });

  it("rejects memories that are not skill candidates", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        memory_items: [
          memoryRow({
            tags: { candidate_skill: false },
          }),
        ],
      }) as never,
    );

    await expect(
      openSkillCandidatePullRequest({
        workspaceId,
        request: { candidateMemoryId },
        config: {
          githubApiToken: "token",
          githubRepoWorkspaceMap: { "kmgrassi/parallel-agent-platform": workspaceId },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_skill_candidate" });
  });
});
