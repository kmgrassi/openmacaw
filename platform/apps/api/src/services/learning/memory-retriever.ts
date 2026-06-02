import { z } from "zod";

import { detectInlineCredentialSecret, getCredentialProviderMetadata } from "../../../../../contracts/credentials.js";
import { MemoryRetrievalScopeSchema, type MemoryHybridSearchResult } from "../../../../../contracts/memory-items.js";
import { logEvent } from "../../logger.js";
import { listWorkspaceModelProviderCredentialRows } from "../../repositories/credentials.js";
import { searchMemoryItemsHybrid } from "../../repositories/memory-items.js";
import { withServiceLogging } from "../service-logging.js";
import { resolveStoredCredentialSecret } from "../stored-credentials.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_IMPORTANCE_MIN = 1;
const DEFAULT_MAX_TOKENS = 1_200;
const MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";

const RetrieveRelevantMemoriesInputSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  queryText: z.string().trim().min(1),
  scope: MemoryRetrievalScopeSchema.default("workspace"),
  importanceMin: z.number().int().min(1).max(10).default(DEFAULT_IMPORTANCE_MIN),
  limit: z.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
  maxTokens: z.number().int().positive().default(DEFAULT_MAX_TOKENS),
});

export type RetrieveRelevantMemoriesInput = z.input<typeof RetrieveRelevantMemoriesInputSchema>;
export type RetrieveRelevantMemoriesResult = {
  results: MemoryHybridSearchResult[];
  embeddingUsed: boolean;
};

type OpenAiEmbeddingResponse = {
  data?: Array<{
    embedding?: unknown;
  }>;
};

function vectorToPgString(embedding: number[]) {
  return `[${embedding.join(",")}]`;
}

function estimateTokens(content: string) {
  return Math.ceil(content.trim().length / 4);
}

function fitToTokenBudget<T extends { content: string }>(results: T[], maxTokens: number): T[] {
  const kept: T[] = [];
  let tokenCount = 0;

  for (const result of results) {
    const nextTokenCount = estimateTokens(result.content);
    if (tokenCount + nextTokenCount > maxTokens) continue;
    kept.push(result);
    tokenCount += nextTokenCount;
  }

  return kept;
}

function dedupeById(results: MemoryHybridSearchResult[]) {
  const byId = new Map<string, MemoryHybridSearchResult>();
  for (const result of results) {
    const existing = byId.get(result.id);
    if (!existing || result.score > existing.score) {
      byId.set(result.id, result);
    }
  }
  return [...byId.values()].sort((left, right) => right.score - left.score);
}

async function resolveWorkspaceOpenAiApiKey(workspaceId: string): Promise<string | null> {
  const credentials = await listWorkspaceModelProviderCredentialRows(workspaceId);
  const credential = credentials.find(
    (row) => row.provider === "openai" && row.user_id === null && row.validation_state !== "invalid",
  );
  if (!credential) return null;
  const raw =
    credential.key_value && typeof credential.key_value === "object" && !Array.isArray(credential.key_value)
      ? (credential.key_value as Record<string, unknown>)
      : {};
  const metadata = getCredentialProviderMetadata("openai");
  return await resolveStoredCredentialSecret({
    secretValue: detectInlineCredentialSecret(raw, metadata) ?? "",
    secretRef: typeof raw.secret_ref === "string" ? raw.secret_ref : null,
    aliases: [...metadata.aliases],
    provider: credential.provider,
  });
}

async function computeQueryEmbedding(input: { workspaceId: string; queryText: string }): Promise<string | null> {
  const apiKey = await resolveWorkspaceOpenAiApiKey(input.workspaceId);
  if (!apiKey) return null;

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MEMORY_EMBEDDING_MODEL,
      input: input.queryText,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI embedding request failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as OpenAiEmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
    throw new Error("OpenAI embedding response did not include a numeric embedding");
  }

  return vectorToPgString(embedding);
}

async function retrieveRelevantMemoriesImpl(
  rawInput: RetrieveRelevantMemoriesInput,
): Promise<RetrieveRelevantMemoriesResult> {
  const input = RetrieveRelevantMemoriesInputSchema.parse(rawInput);
  let queryEmbedding: string | null = null;

  try {
    queryEmbedding = await computeQueryEmbedding({
      workspaceId: input.workspaceId,
      queryText: input.queryText,
    });
  } catch (error) {
    logEvent({
      event: "memory_retriever_embedding_failed",
      level: "warn",
      workspace_id: input.workspaceId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }

  const searchLimit = Math.min(Math.max(input.limit * 3, input.limit), MAX_SEARCH_LIMIT);
  const ownAgentResults =
    input.scope === "workspace" || input.scope === "agent"
      ? await searchMemoryItemsHybrid({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          queryText: input.queryText,
          queryEmbedding,
          limit: searchLimit,
        })
      : [];
  const workspaceResults =
    input.scope === "workspace"
      ? (
          await searchMemoryItemsHybrid({
            workspaceId: input.workspaceId,
            queryText: input.queryText,
            queryEmbedding,
            limit: searchLimit,
          })
        ).filter((result) => result.agentId === null)
      : [];

  const filtered = dedupeById([...ownAgentResults, ...workspaceResults])
    .filter((result) => result.importance >= input.importanceMin)
    .slice(0, searchLimit);
  const budgeted = fitToTokenBudget(filtered, input.maxTokens).slice(0, input.limit);

  return {
    results: budgeted,
    embeddingUsed: Boolean(queryEmbedding),
  };
}

export async function retrieveRelevantMemories(
  input: RetrieveRelevantMemoriesInput,
): Promise<RetrieveRelevantMemoriesResult> {
  return withServiceLogging(
    {
      operation: "learning.memory_retriever.retrieve",
      inputSummary: {
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        scope: input.scope ?? "workspace",
        limit: input.limit ?? DEFAULT_LIMIT,
      },
    },
    () => retrieveRelevantMemoriesImpl(input),
  );
}

export function memoryResultTokenCount(items: MemoryHybridSearchResult[]) {
  return items.reduce((sum, item) => sum + estimateTokens(item.content), 0);
}

export const memoryRetrieverInternalsForTests = {
  estimateTokens,
  fitToTokenBudget,
  vectorToPgString,
};
