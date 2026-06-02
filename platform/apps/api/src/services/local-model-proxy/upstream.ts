import { ApiRouteError } from "../../http.js";
import type { OpenAIToolSpec } from "../tool-spec-translator.js";
import type { ChatCompletionResponse, ChatMessage } from "./types.js";

export async function callLocalModel(input: {
  chatUrl: string;
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools?: OpenAIToolSpec[];
}): Promise<globalThis.Response> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: input.stream,
  };
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = "auto";
  }

  return fetch(input.chatUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function parseModelResponse(response: globalThis.Response): Promise<ChatCompletionResponse> {
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new ApiRouteError(502, "local_model_error", `Local model server returned ${response.status}`, {
      upstream_status: response.status,
      upstream_body: errorText,
    });
  }

  return (await response.json()) as ChatCompletionResponse;
}
