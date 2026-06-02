import { logEvent } from "../../logger.js";
import { listPinnedLongTermMemoryItems } from "../../repositories/memory-items.js";
import type { ApiSupabaseClient } from "../../supabase-client.js";
import { isLearningEnabledForAgent } from "./settings.js";

const PINNED_MEMORY_LIMIT = 3;
const PINNED_MEMORY_TOKEN_BUDGET = 300;

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(lines: string[], maxTokens: number) {
  const selected: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (selected.length > 0 && tokens + lineTokens > maxTokens) break;
    selected.push(line);
    tokens += lineTokens;
  }
  return { lines: selected, tokenCount: tokens };
}

export async function buildPinnedMemoryPromptBlock(input: {
  workspaceId: string;
  agentId: string;
  sessionId?: string | null;
  supabase: ApiSupabaseClient;
}) {
  const enabled = await isLearningEnabledForAgent(input);
  if (!enabled) return null;

  const memories = await listPinnedLongTermMemoryItems({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    limit: PINNED_MEMORY_LIMIT,
    supabase: input.supabase,
  });
  const memoryLines = memories.map((memory) => `- (importance ${memory.importance}) ${memory.content}`);
  const { lines, tokenCount } = truncateToTokenBudget(memoryLines, PINNED_MEMORY_TOKEN_BUDGET);

  logEvent({
    event: "memory_pinned_prompt_built",
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    session_id: input.sessionId ?? null,
    pinned_count: lines.length,
    pinned_token_count: tokenCount,
  });

  return [
    "## Workspace memory (pinned)",
    "",
    "You have access to a workspace memory store from prior agent runs.",
    "Use the `memory.search` tool when you need historical context, prior decisions, or known gotchas. Top long-term facts:",
    "",
    ...lines,
  ].join("\n");
}
