import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ApiRouteError } from "../http.js";

const execFileAsync = promisify(execFile);
const DEFAULT_READ_BYTE_LIMIT = 262_144;
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_SNIPPET_CHARS = 240;
const MAX_DEPTH = 10;
const LOCAL_REPO_TOOL_SLUGS = new Set(["repo.read_file", "repo.list", "repo.search"]);
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".git"]);

type LocalRepoToolResult = {
  status?: number;
  output: string;
};

type SearchMatch = {
  path: string;
  line: number;
  column: number;
  snippet: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeRelativePath(value: string | undefined): string {
  if (!value || value === ".") return ".";
  return value.startsWith(`.${path.sep}`) ? value.slice(2) : value;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error && "code" in error ? error.code : null;
}

export function isLocalRepoToolSlug(slug: string): boolean {
  return LOCAL_REPO_TOOL_SLUGS.has(slug);
}

async function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  const root = await realpath(path.resolve(workspaceRoot));
  const relativePath = requestedPath.trim() || ".";
  if (path.isAbsolute(relativePath)) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "path must be relative to the workspace root");
  }

  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApiRouteError(403, "path_outside_workspace", "path must stay inside the workspace root");
  }

  const realResolved = await realpath(resolved);
  const realRelative = path.relative(root, realResolved);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new ApiRouteError(403, "path_outside_workspace", "path must stay inside the workspace root");
  }

  return realResolved;
}

async function executeReadFile(workspaceRoot: string, args: Record<string, unknown>): Promise<LocalRepoToolResult> {
  const requestedPath = stringArg(args, "path");
  if (!requestedPath) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "path is required");
  }

  const byteLimit = optionalPositiveInteger(args, "byte_limit", DEFAULT_READ_BYTE_LIMIT, DEFAULT_READ_BYTE_LIMIT);
  const filePath = await resolveWorkspacePath(workspaceRoot, requestedPath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "path must reference a file");
  }

  const buffer = await readFile(filePath);
  const truncated = buffer.byteLength > byteLimit;
  const content = buffer.subarray(0, byteLimit).toString("utf8");
  return {
    status: 200,
    output: jsonOutput({
      tool: "repo.read_file",
      path: requestedPath,
      content,
      bytesRead: Math.min(buffer.byteLength, byteLimit),
      truncated,
    }),
  };
}

async function walk(root: string, current: string, depth: number, maxDepth: number, limit: number, entries: unknown[]) {
  if (entries.length >= limit || depth > maxDepth) return;

  const dirents = await readdir(current, { withFileTypes: true });
  for (const dirent of dirents) {
    if (entries.length >= limit) return;
    if (SKIPPED_DIRECTORY_NAMES.has(dirent.name)) continue;

    const fullPath = path.join(current, dirent.name);
    const relativePath = path.relative(root, fullPath) || ".";
    const itemStat = await stat(fullPath);
    entries.push({
      path: relativePath,
      type: dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other",
      size: itemStat.size,
    });
    if (dirent.isDirectory()) {
      await walk(root, fullPath, depth + 1, maxDepth, limit, entries);
    }
  }
}

async function searchWithNode(input: {
  root: string;
  current: string;
  query: string;
  limit: number;
  snippetChars: number;
  matches: SearchMatch[];
}): Promise<void> {
  if (input.matches.length >= input.limit) return;

  const dirents = await readdir(input.current, { withFileTypes: true });
  for (const dirent of dirents) {
    if (input.matches.length >= input.limit) return;
    if (SKIPPED_DIRECTORY_NAMES.has(dirent.name)) continue;

    const fullPath = path.join(input.current, dirent.name);
    if (dirent.isDirectory()) {
      await searchWithNode({ ...input, current: fullPath });
      continue;
    }
    if (!dirent.isFile()) continue;

    const content = await readFile(fullPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const column = line.indexOf(input.query);
      if (column < 0) continue;

      input.matches.push({
        path: path.relative(input.root, fullPath) || ".",
        line: index + 1,
        column: column + 1,
        snippet: line.slice(0, input.snippetChars),
      });

      if (input.matches.length >= input.limit) return;
    }
  }
}

async function executeList(workspaceRoot: string, args: Record<string, unknown>): Promise<LocalRepoToolResult> {
  const requestedPath = stringArg(args, "path") || ".";
  const maxDepth = optionalPositiveInteger(args, "max_depth", 2, MAX_DEPTH);
  const limit = optionalPositiveInteger(args, "limit", DEFAULT_LIST_LIMIT, 1_000);
  const root = await realpath(path.resolve(workspaceRoot));
  const startPath = await resolveWorkspacePath(root, requestedPath);
  const entries: unknown[] = [];
  await walk(root, startPath, 0, maxDepth, limit, entries);

  return {
    status: 200,
    output: jsonOutput({
      tool: "repo.list",
      path: requestedPath,
      entries,
    }),
  };
}

async function executeSearch(workspaceRoot: string, args: Record<string, unknown>): Promise<LocalRepoToolResult> {
  const query = stringArg(args, "query");
  if (!query) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "query is required");
  }

  const requestedPath = stringArg(args, "path") || ".";
  const limit = optionalPositiveInteger(args, "limit", DEFAULT_SEARCH_LIMIT, 200);
  const snippetChars = optionalPositiveInteger(args, "snippet_chars", DEFAULT_SNIPPET_CHARS, 2_000);
  const root = await realpath(path.resolve(workspaceRoot));
  const searchPath = await resolveWorkspacePath(root, requestedPath);
  const relativeSearchPath = path.relative(root, searchPath) || ".";

  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--line-number", "--column", "--fixed-strings", "--no-heading", "--", query, relativeSearchPath],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const matches = stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, limit)
      .flatMap((line) => {
        const parts = line.split(":");
        if (parts.length < 4) return [];
        const [filePath, lineNumber, column, ...snippetParts] = parts;
        return [
          {
            path: normalizeRelativePath(filePath),
            line: Number(lineNumber),
            column: Number(column),
            snippet: snippetParts.join(":").slice(0, snippetChars),
          },
        ];
      });

    return { status: 200, output: jsonOutput({ tool: "repo.search", query, matches }) };
  } catch (error) {
    if (errorCode(error) === 1) {
      return { status: 200, output: jsonOutput({ tool: "repo.search", query, matches: [] }) };
    }
    if (errorCode(error) === "ENOENT") {
      const matches: SearchMatch[] = [];
      await searchWithNode({ root, current: searchPath, query, limit, snippetChars, matches });
      return { status: 200, output: jsonOutput({ tool: "repo.search", query, matches }) };
    }
    throw error;
  }
}

export async function executeLocalRepoTool(input: {
  toolSlug: string;
  argumentsValue: unknown;
  workspaceRoot?: string | null;
}): Promise<LocalRepoToolResult> {
  const workspaceRoot = input.workspaceRoot?.trim();
  if (!workspaceRoot) {
    throw new ApiRouteError(
      409,
      "local_workspace_root_missing",
      "A workspace root is required to execute local repository tools",
    );
  }

  const args = asRecord(input.argumentsValue);
  switch (input.toolSlug) {
    case "repo.read_file":
      return executeReadFile(workspaceRoot, args);
    case "repo.list":
      return executeList(workspaceRoot, args);
    case "repo.search":
      return executeSearch(workspaceRoot, args);
    default:
      throw new ApiRouteError(400, "unsupported_local_repo_tool", `Unsupported repository tool: ${input.toolSlug}`);
  }
}
