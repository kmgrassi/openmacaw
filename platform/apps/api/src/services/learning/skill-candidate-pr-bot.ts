import { Buffer } from "node:buffer";

import type { PostgrestError } from "@supabase/supabase-js";

import type {
  SkillCandidatePrCreateRequest,
  SkillCandidatePrCreateResponse,
} from "../../../../../contracts/learning-skill-prs.js";
import { ApiRouteError } from "../../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../../supabase-client.js";

type JsonRecord = Record<string, unknown>;
type QueryResult<Row> = PromiseLike<{ data: Row[] | Row | null; error: PostgrestError | null }>;
type QueryBuilder<Row> = PromiseLike<{ data: Row[]; error: PostgrestError | null; count: number }> & {
  select(columns?: string): QueryBuilder<Row>;
  eq(column: string, value: unknown): QueryBuilder<Row>;
  in(column: string, value: unknown[]): QueryBuilder<Row>;
  limit(count: number): QueryBuilder<Row>;
  single(): QueryResult<Row>;
};
type LearningSupabase = {
  from<Row = JsonRecord>(table: string): QueryBuilder<Row>;
};

type MemoryItemRow = {
  id: string;
  workspace_id: string;
  content: string;
  scope: string;
  source_run_id: string | null;
  source_task_id: string | null;
  tags: unknown;
  is_deleted: boolean;
};

type GitHubRepository = {
  default_branch?: string;
};

type GitHubRef = {
  object?: {
    sha?: string;
  };
};

type GitHubPullRequest = {
  html_url?: string;
  number?: number;
};

export type SkillCandidatePrBotConfig = {
  githubApiToken: string | null;
  githubRepoWorkspaceMap: Record<string, string>;
};

type GitHubRequestOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
};

function learningSupabase(): LearningSupabase {
  return getServiceRoleSupabase() as unknown as LearningSupabase;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function tagString(tags: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = tags[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function resolveWorkspaceRepository(input: {
  workspaceId: string;
  requestedRepository?: string;
  githubRepoWorkspaceMap: Record<string, string>;
}): string {
  const matches = Object.entries(input.githubRepoWorkspaceMap)
    .filter(([, workspaceId]) => workspaceId === input.workspaceId)
    .map(([repository]) => repository);

  if (input.requestedRepository) {
    if (!matches.includes(input.requestedRepository)) {
      throw new ApiRouteError(403, "repository_not_bound", "Requested repository is not bound to the workspace", {
        repository: input.requestedRepository,
        workspaceId: input.workspaceId,
      });
    }
    return input.requestedRepository;
  }

  if (matches.length === 1) return matches[0]!;

  if (matches.length === 0) {
    throw new ApiRouteError(409, "repository_binding_missing", "Workspace does not have a GitHub repository binding", {
      workspaceId: input.workspaceId,
    });
  }

  throw new ApiRouteError(
    409,
    "repository_binding_ambiguous",
    "Workspace has multiple GitHub repository bindings; repository is required",
    { repositories: matches },
  );
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

function titleFromCandidate(memory: MemoryItemRow, tags: JsonRecord, requestTitle?: string) {
  const explicitTitle = requestTitle ?? tagString(tags, "skill_title", "title");
  if (explicitTitle) return explicitTitle;

  const heading = memory.content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"));
  if (heading) return heading.replace(/^#+\s*/, "").trim();

  return memory.content.split(/\s+/).slice(0, 8).join(" ");
}

function skillSlug(memory: MemoryItemRow, tags: JsonRecord, request: SkillCandidatePrCreateRequest) {
  const rawSlug = request.slug ?? tagString(tags, "skill_slug", "slug");
  const slug = rawSlug ? slugify(rawSlug) : slugify(titleFromCandidate(memory, tags, request.title));
  if (!slug) {
    throw new ApiRouteError(
      400,
      "invalid_skill_candidate",
      "Skill candidate did not contain enough text to derive a slug",
    );
  }
  return slug;
}

function skillMarkdown(memory: MemoryItemRow, tags: JsonRecord, title: string) {
  const taggedBody = tagString(tags, "skill_markdown", "markdown");
  const body = taggedBody ?? memory.content.trim();
  if (!body) {
    throw new ApiRouteError(400, "invalid_skill_candidate", "Skill candidate content is empty");
  }
  if (body.startsWith("---") || body.startsWith("#")) return `${body}\n`;
  return `# ${title}\n\n${body}\n`;
}

function branchName(slug: string, candidateMemoryId: string) {
  return `codex/skill-candidate-${slug}-${candidateMemoryId.slice(0, 8)}`;
}

function sourceMemoryIds(candidate: MemoryItemRow, tags: JsonRecord) {
  const taggedIds = stringArray(tags.source_memory_ids ?? tags.sourceMemoryIds);
  return Array.from(new Set([candidate.id, ...taggedIds]));
}

function candidatePrBody(input: { candidate: MemoryItemRow; sources: MemoryItemRow[]; skillPath: string }) {
  const sourceLines = input.sources
    .map((source) => {
      const run = source.source_run_id ? `, source run \`${source.source_run_id}\`` : "";
      const task = source.source_task_id ? `, source task \`${source.source_task_id}\`` : "";
      return `- memory \`${source.id}\`${run}${task}`;
    })
    .join("\n");

  return [
    "## Summary",
    "",
    `Adds proposed Codex skill \`${input.skillPath}\` from a learning-sidecar skill candidate.`,
    "",
    "## Source Memories",
    "",
    sourceLines,
    "",
    "## Review Notes",
    "",
    "This PR is intentionally human-reviewed before the skill can affect future agent runs.",
    "",
  ].join("\n");
}

async function githubRequest<T>(token: string, path: string, options: GitHubRequestOptions = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "parallel-agent-platform-learning-sidecar",
      "x-github-api-version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new ApiRouteError(response.status, "github_request_failed", "GitHub request failed", {
      path,
      status: response.status,
      details,
    });
  }

  return (await response.json()) as T;
}

async function fetchMemoryItem(workspaceId: string, candidateMemoryId: string) {
  const rows = await executeSupabaseRows<MemoryItemRow>(
    "fetch skill candidate memory",
    learningSupabase()
      .from("memory_items")
      .select("id, workspace_id, content, scope, source_run_id, source_task_id, tags, is_deleted")
      .eq("id", candidateMemoryId)
      .eq("workspace_id", workspaceId)
      .eq("is_deleted", false)
      .limit(1),
  );
  return rows[0] ?? null;
}

async function fetchSourceMemories(workspaceId: string, ids: string[]) {
  return executeSupabaseRows<MemoryItemRow>(
    "fetch skill candidate source memories",
    learningSupabase()
      .from("memory_items")
      .select("id, workspace_id, content, scope, source_run_id, source_task_id, tags, is_deleted")
      .eq("workspace_id", workspaceId)
      .in("id", ids)
      .eq("is_deleted", false),
  );
}

export async function openSkillCandidatePullRequest(input: {
  workspaceId: string;
  request: SkillCandidatePrCreateRequest;
  config: SkillCandidatePrBotConfig;
}): Promise<SkillCandidatePrCreateResponse> {
  if (!input.config.githubApiToken) {
    throw new ApiRouteError(503, "github_pr_bot_unconfigured", "GitHub API token is not configured");
  }

  const candidate = await fetchMemoryItem(input.workspaceId, input.request.candidateMemoryId);
  if (!candidate) {
    throw new ApiRouteError(404, "memory_item_not_found", "Candidate memory item was not found");
  }

  const tags = asRecord(candidate.tags);
  if (tags.candidate_skill !== true) {
    throw new ApiRouteError(400, "invalid_skill_candidate", "Memory item is not tagged candidate_skill=true");
  }

  const repository = resolveWorkspaceRepository({
    workspaceId: input.workspaceId,
    requestedRepository: input.request.repository,
    githubRepoWorkspaceMap: input.config.githubRepoWorkspaceMap,
  });
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new ApiRouteError(500, "repository_binding_invalid", "Resolved repository binding is invalid", {
      repository,
    });
  }
  const title = titleFromCandidate(candidate, tags, input.request.title);
  const slug = skillSlug(candidate, tags, input.request);
  const branch = branchName(slug, candidate.id);
  const skillPath = `.codex/skills/${slug}.md`;
  const content = skillMarkdown(candidate, tags, title);
  const ids = sourceMemoryIds(candidate, tags);
  const sources = await fetchSourceMemories(input.workspaceId, ids);

  const repoInfo = await githubRequest<GitHubRepository>(input.config.githubApiToken, `/repos/${owner}/${repo}`);
  const baseBranch = input.request.baseBranch ?? repoInfo.default_branch ?? "main";
  const baseRef = await githubRequest<GitHubRef>(
    input.config.githubApiToken,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
  );
  const baseSha = baseRef.object?.sha;
  if (!baseSha) {
    throw new ApiRouteError(502, "github_base_ref_invalid", "GitHub base branch did not include a commit SHA");
  }

  await githubRequest(input.config.githubApiToken, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    },
  });

  await githubRequest(input.config.githubApiToken, `/repos/${owner}/${repo}/contents/${skillPath}`, {
    method: "PUT",
    body: {
      message: `Add skill candidate ${slug}`,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
    },
  });

  const pr = await githubRequest<GitHubPullRequest>(input.config.githubApiToken, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: {
      title: `Add skill candidate: ${title}`,
      head: branch,
      base: baseBranch,
      body: candidatePrBody({ candidate, sources: sources.length > 0 ? sources : [candidate], skillPath }),
      draft: false,
    },
  });

  if (!pr.html_url || typeof pr.number !== "number") {
    throw new ApiRouteError(502, "github_pr_response_invalid", "GitHub PR response was missing url or number");
  }

  return {
    candidateMemoryId: candidate.id,
    sourceMemoryIds: ids,
    pullRequest: {
      url: pr.html_url,
      number: pr.number,
      repository,
      branch,
      baseBranch,
      skillPath,
    },
  };
}
