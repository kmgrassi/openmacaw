import type { ToolDefinition } from "../tool-spec-translator.js";

export const MEMORY_SEARCH_TOOL_ID = "11111111-1111-4111-8111-111111111111";
export const MEMORY_SEARCH_TOOL_SLUG = "memory.search";

export const MEMORY_SEARCH_TOOL: ToolDefinition = {
  id: MEMORY_SEARCH_TOOL_ID,
  slug: MEMORY_SEARCH_TOOL_SLUG,
  name: "Search memory",
  functionName: "memory_search",
  description:
    "Search workspace memory from prior agent runs for historical context, prior decisions, recurring failures, or known gotchas.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Natural language memory search query.",
      },
      scope: {
        type: "string",
        enum: ["workspace", "agent"],
        description: "Visibility scope for matching memories.",
      },
      importance_min: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Minimum memory importance from 1 to 10.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of memories to return.",
      },
    },
    required: ["query"],
  },
  executionKind: "database",
  runnerKind: null,
  enabled: true,
};
