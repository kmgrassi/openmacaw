import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApiRouteError } from "../http.js";
import { executeLocalRepoTool } from "./local-repo-tool-executor.js";

describe("executeLocalRepoTool", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "platform-local-repo-tool-"));
    await writeFile(path.join(workspaceRoot, "README.md"), "# Test repo\n\nneedle\n", "utf8");
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export const value = 'needle';\n", "utf8");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("reads a workspace-relative file", async () => {
    const result = await executeLocalRepoTool({
      toolSlug: "repo.read_file",
      workspaceRoot,
      argumentsValue: { path: "README.md" },
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output)).toMatchObject({
      tool: "repo.read_file",
      path: "README.md",
      content: expect.stringContaining("needle"),
      truncated: false,
    });
  });

  it("blocks paths outside the workspace root", async () => {
    await expect(
      executeLocalRepoTool({
        toolSlug: "repo.read_file",
        workspaceRoot,
        argumentsValue: { path: "../escape.txt" },
      }),
    ).rejects.toMatchObject({
      code: "path_outside_workspace",
    } satisfies Partial<ApiRouteError>);
  });

  it("blocks symlinks that resolve outside the workspace root", async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "platform-local-repo-outside-"));
    try {
      await writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
      await symlink(path.join(outsideDir, "secret.txt"), path.join(workspaceRoot, "secret-link.txt"));

      await expect(
        executeLocalRepoTool({
          toolSlug: "repo.read_file",
          workspaceRoot,
          argumentsValue: { path: "secret-link.txt" },
        }),
      ).rejects.toMatchObject({
        code: "path_outside_workspace",
      } satisfies Partial<ApiRouteError>);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("lists files under the workspace", async () => {
    const result = await executeLocalRepoTool({
      toolSlug: "repo.list",
      workspaceRoot,
      argumentsValue: { path: ".", max_depth: 2 },
    });

    const output = JSON.parse(result.output);
    expect(output.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "README.md", type: "file" }),
        expect.objectContaining({ path: "src", type: "directory" }),
      ]),
    );
  });

  it("searches files under the workspace", async () => {
    const result = await executeLocalRepoTool({
      toolSlug: "repo.search",
      workspaceRoot,
      argumentsValue: { query: "needle" },
    });

    const output = JSON.parse(result.output);
    expect(output.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "README.md" }),
        expect.objectContaining({ path: "src/index.ts" }),
      ]),
    );
  });
});
