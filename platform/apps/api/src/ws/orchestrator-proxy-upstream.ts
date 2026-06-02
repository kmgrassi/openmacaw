import type { IncomingMessage } from "node:http";

import { WebSocket } from "ws";

import { errorMessage, logEvent } from "../logger.js";
import { RuntimeTargetError, resolveRuntimeTargetForAgent } from "../services/runtime-target.js";
import type { UpstreamResponse } from "../services/upstream.js";

import type { PendingWebSocketMessage } from "./orchestrator-proxy-router.js";

export type BufferedUpstream = {
  upstream: WebSocket;
  pendingMessages: PendingWebSocketMessage[];
  detachPendingBuffer: () => void;
};

export async function connectUpstreamWebSocket(init: {
  request: IncomingMessage;
  agentId: string;
  headers: Record<string, string>;
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>;
  wsConnectTimeoutMs: number;
}) {
  const { request, agentId, headers, launcherRequest, wsConnectTimeoutMs } = init;
  const requestUrl = new URL(request.url ?? "", "http://127.0.0.1");

  const upstreamUrlCategory = (instanceId: string) =>
    instanceId === "launcher-runtime" ? "launcher_runtime" : "engine_instance";

  const connectToTarget = async () => {
    const target = await resolveRuntimeTargetForAgent(agentId, launcherRequest);
    const upstreamUrl = new URL(target.wsUrl);
    upstreamUrl.search = requestUrl.search;
    const startedAt = Date.now();
    const upstream_url_category = upstreamUrlCategory(target.instanceId);
    logEvent({
      event: "gateway_ws_upstream_connect_started",
      agent_id: agentId,
      workspace_id: target.workspaceId,
      upstream_url_category,
      upstream_host: upstreamUrl.host,
      upstream_path: upstreamUrl.pathname,
      runtime_instance_id: target.instanceId,
    });

    return await new Promise<BufferedUpstream>((resolve, reject) => {
      const upstream = new WebSocket(String(upstreamUrl), { headers });
      const timer = setTimeout(() => {
        if (upstream.readyState === WebSocket.CONNECTING) {
          upstream.terminate();
          logEvent({
            event: "gateway_ws_upstream_timeout",
            level: "error",
            agent_id: agentId,
            workspace_id: target.workspaceId,
            upstream_url_category,
            duration_ms: Date.now() - startedAt,
          });
          reject(
            new RuntimeTargetError({
              statusCode: 504,
              code: "orchestrator_timeout",
              message: "Upstream websocket timeout",
            }),
          );
        }
      }, wsConnectTimeoutMs);

      upstream.once("open", () => {
        clearTimeout(timer);
        logEvent({
          event: "gateway_ws_opened",
          connection_side: "upstream",
          agent_id: agentId,
          workspace_id: target.workspaceId,
          upstream_url_category,
          handshake_duration_ms: Date.now() - startedAt,
        });
        const pendingMessages: PendingWebSocketMessage[] = [];
        const bufferMessage = (data: WebSocket.Data, isBinary: boolean) => {
          pendingMessages.push({ data, isBinary });
        };
        upstream.on("message", bufferMessage);
        resolve({
          upstream,
          pendingMessages,
          detachPendingBuffer: () => upstream.off("message", bufferMessage),
        });
      });
      upstream.once("error", (error) => {
        clearTimeout(timer);
        logEvent({
          event: "gateway_ws_upstream_failed",
          level: "error",
          agent_id: agentId,
          workspace_id: target.workspaceId,
          upstream_url_category,
          duration_ms: Date.now() - startedAt,
          error: errorMessage(error),
        });
        reject(error);
      });
    });
  };

  try {
    return await connectToTarget();
  } catch {
    await launcherRequest(`/agents/${encodeURIComponent(agentId)}`, { method: "GET" }).catch(() => undefined);
    return await connectToTarget();
  }
}
