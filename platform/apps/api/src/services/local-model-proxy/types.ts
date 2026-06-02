import type { ParsedToolCall } from "../tool-call-parser.js";

export type ChatMessage = Record<string, unknown> & {
  role: string;
  content?: string | null;
};

export type ChatCompletionResponse = Record<string, unknown> & {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    index?: number;
    message?: ChatMessage & {
      tool_calls?: ParsedToolCall[];
    };
  }>;
};
