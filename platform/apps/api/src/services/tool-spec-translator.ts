export type ToolDefinition = {
  id: string;
  slug: string;
  name: string;
  description: string;
  functionName: string;
  parameters: Record<string, unknown>;
  examples?: unknown[];
  executionKind: string | null;
  runnerKind: string | null;
  enabled: boolean;
};

export type OpenAIToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AnthropicToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type GenericToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const FUNCTION_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

function sanitizeFunctionName(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  const prefixed = /^[a-zA-Z_]/.test(normalized) ? normalized : `tool_${normalized}`;
  return prefixed.slice(0, 64);
}

function examplesDescription(examples: unknown[] | undefined): string {
  if (!examples || examples.length === 0) return "";
  return `\n\nExamples / usage guidance:\n${JSON.stringify(examples.slice(0, 5))}`;
}

function toolDescription(tool: Pick<ToolDefinition, "description" | "examples">): string {
  return `${tool.description}${examplesDescription(tool.examples)}`;
}

export function toolFunctionName(tool: Pick<ToolDefinition, "functionName" | "slug" | "name">): string {
  const candidate = tool.functionName.trim() || tool.slug.trim() || tool.name.trim();
  if (FUNCTION_NAME_PATTERN.test(candidate)) return candidate;
  return sanitizeFunctionName(candidate);
}

export function toOpenAIToolSpec(tool: ToolDefinition): OpenAIToolSpec {
  return {
    type: "function",
    function: {
      name: toolFunctionName(tool),
      description: toolDescription(tool),
      parameters: tool.parameters,
    },
  };
}

export function toAnthropicToolSpec(tool: ToolDefinition): AnthropicToolSpec {
  return {
    name: toolFunctionName(tool),
    description: toolDescription(tool),
    input_schema: tool.parameters,
  };
}

export function toGenericToolSpec(tool: ToolDefinition): GenericToolSpec {
  return {
    name: toolFunctionName(tool),
    description: toolDescription(tool),
    parameters: tool.parameters,
  };
}

export function toOpenAIToolSpecs(tools: ToolDefinition[]): OpenAIToolSpec[] {
  return tools.filter((tool) => tool.enabled).map(toOpenAIToolSpec);
}

export function toolsByProviderFunctionName(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.filter((tool) => tool.enabled).map((tool) => [toolFunctionName(tool), tool]));
}

export function buildToolUseSystemPrompt(tools: ToolDefinition[]): string {
  const toolDescriptions = tools
    .filter((tool) => tool.enabled)
    .map((tool) => {
      return `- ${toolFunctionName(tool)}: ${toolDescription(tool)}\n  Parameters: ${JSON.stringify(tool.parameters)}`;
    })
    .join("\n");

  return [
    "You have access to tools. To use a tool, respond with a JSON block:",
    '```json\n{"tool_call":{"name":"tool_name","arguments":{}}}\n```',
    "Available tools:",
    toolDescriptions,
    "When you are ready to answer the user, respond normally without a tool_call JSON block.",
  ].join("\n\n");
}
