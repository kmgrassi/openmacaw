import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { MemoryItem } from "../../../../../contracts/memory-items.js";
import { ApiRouteError } from "../../http.js";
import { logEvent } from "../../logger.js";
import { insertMemoryItem, listRecentRunSummaryMemories } from "../../repositories/memory-items.js";

export const DistilledSkillCandidateSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(10).max(1000),
  body: z.string().trim().min(40).max(12000),
  confidence: z.number().min(0).max(1),
});

export type DistilledSkillCandidate = z.infer<typeof DistilledSkillCandidateSchema>;

export type LearningDistillerAnalyzer = (input: {
  workspaceId: string;
  clusterId: string;
  memories: MemoryItem[];
}) => Promise<DistilledSkillCandidate | null>;

export type LearningDistillationResult = {
  workspaceId: string;
  consideredMemoryCount: number;
  clusterCount: number;
  candidateCount: number;
  candidateMemoryIds: string[];
};

type LearningDistillerOptions = {
  analyzer?: LearningDistillerAnalyzer;
  now?: Date;
  maxMemories?: number;
  minImportance?: number;
  minClusterSize?: number;
};

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_MIN_IMPORTANCE = 7;
const DEFAULT_MAX_MEMORIES = 250;
const DEFAULT_MIN_CLUSTER_SIZE = 2;
const MIN_CLUSTER_SIMILARITY = 0.14;

function cutoffForWindow(now: Date, windowDays: number) {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}

function tokenize(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 4),
  );
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function clusterRunSummaries(memories: MemoryItem[], minClusterSize: number) {
  const clusters: MemoryItem[][] = [];
  const clusterTokens: Set<string>[] = [];

  for (const memory of memories) {
    const tokens = tokenize(memory.content);
    let bestClusterIndex = -1;
    let bestScore = 0;

    clusterTokens.forEach((existingTokens, index) => {
      const score = jaccard(tokens, existingTokens);
      if (score > bestScore) {
        bestScore = score;
        bestClusterIndex = index;
      }
    });

    if (bestClusterIndex >= 0 && bestScore >= MIN_CLUSTER_SIMILARITY) {
      clusters[bestClusterIndex]?.push(memory);
      for (const token of tokens) clusterTokens[bestClusterIndex]?.add(token);
    } else {
      clusters.push([memory]);
      clusterTokens.push(tokens);
    }
  }

  return clusters.filter((cluster) => cluster.length >= minClusterSize);
}

function openAiConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.LEARNING_DISTILLATION_MODEL?.trim();
  if (!apiKey) {
    throw new ApiRouteError(
      503,
      "learning_distiller_unconfigured",
      "OPENAI_API_KEY is required for skill distillation",
    );
  }
  if (!model) {
    throw new ApiRouteError(
      503,
      "learning_distiller_unconfigured",
      "LEARNING_DISTILLATION_MODEL is required for skill distillation",
    );
  }
  return { apiKey, model };
}

function extractResponseText(payload: unknown) {
  const output = (payload as { output?: Array<{ content?: Array<{ text?: string }> }> })?.output;
  const text = output
    ?.flatMap((entry) => entry.content ?? [])
    .map((content) => content.text)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (text) return text;
  return (payload as { output_text?: unknown }).output_text;
}

function parseCandidateJson(text: unknown) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed === "null") return null;
  const unwrapped = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return DistilledSkillCandidateSchema.nullable().parse(JSON.parse(unwrapped));
}

function tagsRecord(tags: MemoryItem["tags"]): Record<string, unknown> {
  return tags && typeof tags === "object" && !Array.isArray(tags) ? (tags as Record<string, unknown>) : {};
}

function candidateImportance(confidence: number) {
  return Math.max(Math.ceil(confidence * 10), DEFAULT_MIN_IMPORTANCE);
}

export async function analyzeClusterWithOpenAI(input: {
  workspaceId: string;
  clusterId: string;
  memories: MemoryItem[];
}): Promise<DistilledSkillCandidate | null> {
  const { apiKey, model } = openAiConfig();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You identify reusable Codex skills from repeated workspace run summaries. Return only JSON matching {slug,title,summary,body,confidence}, or null when the cluster is not a reusable skill.",
        },
        {
          role: "user",
          content: JSON.stringify({
            workspaceId: input.workspaceId,
            clusterId: input.clusterId,
            memories: input.memories.map((memory) => ({
              id: memory.id,
              sourceRunId: memory.sourceRunId,
              sourceTaskId: memory.sourceTaskId,
              content: memory.content,
              importance: memory.importance,
              eventTime: memory.eventTime,
            })),
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiRouteError(502, "learning_distiller_model_error", "Skill distillation model request failed", {
      upstreamStatus: response.status,
      upstreamBody: body,
    });
  }

  return parseCandidateJson(extractResponseText(await response.json()));
}

function candidateContent(candidate: DistilledSkillCandidate) {
  return [`# ${candidate.title}`, "", candidate.summary, "", "```json", JSON.stringify(candidate, null, 2), "```"].join(
    "\n",
  );
}

export async function distillWorkspaceSkills(
  workspaceId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
  options: LearningDistillerOptions = {},
): Promise<LearningDistillationResult> {
  const now = options.now ?? new Date();
  const cutoff = cutoffForWindow(now, windowDays);
  const memories = (
    await listRecentRunSummaryMemories({
      workspaceId,
      limit: options.maxMemories ?? DEFAULT_MAX_MEMORIES,
    })
  ).filter(
    (memory) =>
      tagsRecord(memory.tags).candidate_skill !== true &&
      memory.importance >= (options.minImportance ?? DEFAULT_MIN_IMPORTANCE) &&
      new Date(memory.eventTime).getTime() >= cutoff.getTime(),
  );
  const clusters = clusterRunSummaries(memories, options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);
  const analyzer = options.analyzer ?? analyzeClusterWithOpenAI;
  const candidateMemoryIds: string[] = [];

  for (const cluster of clusters) {
    const clusterId = randomUUID();
    const candidate = await analyzer({ workspaceId, clusterId, memories: cluster });
    if (!candidate) continue;

    const inserted = await insertMemoryItem({
      workspaceId,
      content: candidateContent(candidate),
      eventTime: now.toISOString(),
      importance: candidateImportance(candidate.confidence),
      scope: "run_summary",
      tags: {
        candidate_skill: true,
        cluster_id: clusterId,
        skill_slug: candidate.slug,
        source_memory_ids: cluster.map((memory) => memory.id),
        source_run_ids: cluster.map((memory) => memory.sourceRunId).filter(Boolean),
      },
    });
    candidateMemoryIds.push(inserted.id);
  }

  const result = {
    workspaceId,
    consideredMemoryCount: memories.length,
    clusterCount: clusters.length,
    candidateCount: candidateMemoryIds.length,
    candidateMemoryIds,
  };
  logEvent({ event: "learning_distillation_completed", ...result });
  return result;
}
