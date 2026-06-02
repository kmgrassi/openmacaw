export type ParsedToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  promptBasedFallback?: boolean;
};

type ChatChoice = {
  message?: {
    content?: string | null;
    tool_calls?: unknown;
  };
};

type ChatCompletionResponse = {
  choices?: ChatChoice[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (asRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  return "{}";
}

function parseNativeToolCalls(rawToolCalls: unknown): ParsedToolCall[] {
  if (!Array.isArray(rawToolCalls)) return [];

  return rawToolCalls.flatMap((rawCall, index) => {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!call || !name) return [];

    const id = typeof call.id === "string" && call.id.trim() ? call.id : `tool-call-${index + 1}`;
    return [
      {
        id,
        type: "function" as const,
        function: {
          name,
          arguments: normalizeArguments(fn?.arguments),
        },
      },
    ];
  });
}

function extractJsonBlocks(content: string): string[] {
  const blocks: string[] = [];
  const fencedBlockPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencedBlockPattern.exec(content)) !== null) {
    if (match[1]?.trim()) blocks.push(match[1].trim());
  }
  blocks.push(content.trim());
  return blocks;
}

function parsePromptFallbackToolCall(content: string): ParsedToolCall[] {
  for (const candidate of extractJsonBlocks(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const root = asRecord(parsed);
      const rawToolCall = asRecord(root?.tool_call) ?? asRecord(root?.toolCall);
      const name = typeof rawToolCall?.name === "string" ? rawToolCall.name.trim() : "";
      if (!name) continue;

      return [
        {
          id: `prompt-tool-call-${Date.now()}`,
          type: "function",
          promptBasedFallback: true,
          function: {
            name,
            arguments: normalizeArguments(rawToolCall?.arguments),
          },
        },
      ];
    } catch {
      continue;
    }
  }

  const tagCall = parseTaggedToolCall(content);
  if (tagCall) return [tagCall];

  return [];
}

function parseTaggedToolCall(content: string): ParsedToolCall | null {
  const functionMatch = content.match(/<function=([a-zA-Z_][a-zA-Z0-9_-]{0,63})>\s*([\s\S]*?)<\/function>/i);
  const name = functionMatch?.[1]?.trim() ?? "";
  const body = functionMatch?.[2] ?? "";
  if (!name || !body) return null;

  const parameters: Record<string, string> = {};
  const parameterPattern = /<parameter=([a-zA-Z_][a-zA-Z0-9_-]{0,63})>\s*([\s\S]*?)\s*<\/parameter>/gi;
  let parameterMatch: RegExpExecArray | null;
  while ((parameterMatch = parameterPattern.exec(body)) !== null) {
    const key = parameterMatch[1]?.trim();
    const value = parameterMatch[2]?.trim();
    if (key && value !== undefined) parameters[key] = value;
  }

  return {
    id: `prompt-tool-call-${Date.now()}`,
    type: "function",
    promptBasedFallback: true,
    function: {
      name,
      arguments: JSON.stringify(parameters),
    },
  };
}

export function extractToolCalls(response: ChatCompletionResponse): ParsedToolCall[] {
  const message = response.choices?.[0]?.message;
  if (!message) return [];

  const nativeToolCalls = parseNativeToolCalls(message.tool_calls);
  if (nativeToolCalls.length > 0) return nativeToolCalls;

  return typeof message.content === "string" ? parsePromptFallbackToolCall(message.content) : [];
}

export function hasToolCalls(response: ChatCompletionResponse): boolean {
  return extractToolCalls(response).length > 0;
}
