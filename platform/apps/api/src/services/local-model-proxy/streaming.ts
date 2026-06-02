import type { Response } from "express";

import { ApiRouteError } from "../../http.js";
import type { ChatCompletionResponse } from "./types.js";

export function completionToStreamingChunks(
  completion: ChatCompletionResponse,
  model: string,
): Record<string, unknown>[] {
  const choice = completion.choices?.[0];
  const content = choice?.message?.content ?? "";
  const chunkBase = {
    id: completion.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: completion.model ?? model,
  };

  return [
    {
      ...chunkBase,
      choices: [
        {
          index: choice?.index ?? 0,
          delta: {
            role: "assistant",
            content,
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...chunkBase,
      choices: [
        {
          index: choice?.index ?? 0,
          delta: {},
          finish_reason: choice?.finish_reason ?? "stop",
        },
      ],
    },
  ];
}

export function writeCompletionAsSse(res: Response, completion: ChatCompletionResponse, model: string): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  for (const chunk of completionToStreamingChunks(completion, model)) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function pipeStreamingResponse(upstreamResponse: globalThis.Response, res: Response): Promise<void> {
  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => "");
    throw new ApiRouteError(502, "local_model_error", `Local model server returned ${upstreamResponse.status}`, {
      upstream_status: upstreamResponse.status,
      upstream_body: errorText,
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const body = upstreamResponse.body;
  if (!body) {
    throw new ApiRouteError(502, "local_model_error", "No response body from local model server");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();

  const pump = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) {
      res.end();
      return;
    }
    const chunk = decoder.decode(value, { stream: true });
    res.write(chunk);
    return pump();
  };

  await pump();
}
