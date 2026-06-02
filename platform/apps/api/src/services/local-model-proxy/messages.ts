import type { ToolExecutionContext } from "../tool-execution-client.js";
import type { ParsedToolCall } from "../tool-call-parser.js";
import { buildToolUseSystemPrompt, type ToolDefinition } from "../tool-spec-translator.js";
import type { ChatMessage } from "./types.js";

export function buildPromptFallbackMessages(messages: ChatMessage[], tools: ToolDefinition[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: buildToolUseSystemPrompt(tools),
    },
    ...messages,
  ];
}

export function buildRuntimeContextMessage(context: ToolExecutionContext): ChatMessage {
  return {
    role: "system",
    content: [
      "Runtime context for this chat is already available. Use these IDs when a tool schema asks for them; do not ask the user to provide them.",
      "Do not invent or override workspace, user, session, or agent IDs in tool arguments; the executor receives authoritative context out-of-band.",
      `agent_id: ${context.agentId ?? ""}`,
      `workspace_id: ${context.workspaceId ?? ""}`,
      `user_id: ${context.userId ?? ""}`,
      `session_id: ${context.sessionId ?? ""}`,
      `execution_target: ${context.executionTarget?.kind ?? ""}`,
      `workspace_root_ref: ${
        context.executionTarget?.kind === "local_helper" ? context.executionTarget.workspaceRootRef : ""
      }`,
      `workspace_root_available: ${context.workspaceRoot ? "true" : "false"}`,
    ].join("\n"),
  };
}

export function withRuntimeContext(messages: ChatMessage[], context: ToolExecutionContext): ChatMessage[] {
  return [buildRuntimeContextMessage(context), ...messages];
}

export function messageWithToolCalls(message: ChatMessage | undefined, toolCalls: ParsedToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: message?.content ?? null,
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: toolCall.type,
      function: toolCall.function,
    })),
  };
}

export function promptFallbackConversationMessages(
  messages: ChatMessage[],
  context: ToolExecutionContext,
  tools: ToolDefinition[],
): ChatMessage[] {
  return buildPromptFallbackMessages(withRuntimeContext(messages, context), tools);
}
