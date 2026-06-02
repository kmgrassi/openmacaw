import type { Server } from "node:http";

import { WebSocketServer } from "ws";

import { errorMessage, logEvent } from "../logger.js";
import { AuthJwtError } from "../middleware/authJwt.js";
import { withRequestContext } from "../middleware/request-context.js";
import { RuntimeTargetError } from "../services/runtime-target.js";
import type { UpstreamResponse } from "../services/upstream.js";

import {
  createWebSocketRequestContext,
  logWebSocketEvent,
  responseContextHeaders,
} from "./orchestrator-proxy-context.js";
import { bindWebSocketPair } from "./orchestrator-proxy-router.js";
import { prepareAuthenticatedWebSocketSession, requestAgentId } from "./orchestrator-proxy-session.js";
import { connectUpstreamWebSocket } from "./orchestrator-proxy-upstream.js";
import { sanitizeUrlForLogs, WebSocketUpgradeError, writeUpgradeJson } from "./orchestrator-proxy-upgrade.js";

export function attachOrchestratorWebSocketProxy(
  server: Server,
  config: {
    wsUpgradePath: string;
    wsConnectTimeoutMs: number;
  },
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    const context = createWebSocketRequestContext(request);
    const responseHeaders = responseContextHeaders(context);
    await withRequestContext(context, async () => {
      try {
        if (!request.url || !request.url.startsWith(config.wsUpgradePath)) {
          socket.destroy();
          return;
        }

        const agentId = requestAgentId(request);
        if (!agentId) {
          logEvent({
            event: "gateway_ws_missing_agent_id",
            level: "warn",
            url: sanitizeUrlForLogs(request.url),
          });
          writeUpgradeJson(
            socket,
            400,
            {
              error: {
                code: "agent_id_required",
                message: "agent_id is required to resolve a runtime websocket target",
              },
            },
            responseHeaders,
          );
          return;
        }
        logEvent({
          event: "gateway_ws_upgrade_started",
          agent_id: agentId,
          url: sanitizeUrlForLogs(request.url),
        });

        const session = await prepareAuthenticatedWebSocketSession(request, agentId);
        const upstream = await connectUpstreamWebSocket({
          request,
          agentId,
          headers: session.headers,
          launcherRequest,
          wsConnectTimeoutMs: config.wsConnectTimeoutMs,
        });

        wss.handleUpgrade(request, socket, head, (clientSocket) => {
          logWebSocketEvent(context, {
            event: "gateway_ws_opened",
            connection_side: "client",
            agent_id: agentId,
            auth_user_id: session.authUserId,
            app_user_id: session.userId,
          });
          bindWebSocketPair(
            clientSocket,
            upstream.upstream,
            context,
            agentId,
            upstream.pendingMessages,
            upstream.detachPendingBuffer,
          );
        });
      } catch (error) {
        if (error instanceof WebSocketUpgradeError) {
          writeUpgradeJson(
            socket,
            error.statusCode,
            {
              error: {
                code: error.code,
                message: error.message,
              },
            },
            responseHeaders,
          );
          return;
        }

        if (error instanceof RuntimeTargetError) {
          logEvent({
            event:
              error.code === "orchestrator_timeout" ? "gateway_ws_upstream_timeout" : "gateway_ws_launcher_unavailable",
            level: "error",
            agent_id: requestAgentId(request),
            error_code: error.code,
            retryable: error.retriable,
            error: errorMessage(error),
          });
          writeUpgradeJson(
            socket,
            error.statusCode,
            {
              error: {
                code: error.code,
                message: error.message,
                details: { retriable: error.retriable },
              },
            },
            responseHeaders,
          );
          return;
        }

        if (error instanceof AuthJwtError) {
          logEvent({
            event: "gateway_ws_invalid_token",
            level: "warn",
            agent_id: requestAgentId(request),
            auth_result: "invalid_token",
            error_code: error.code,
          });
          writeUpgradeJson(
            socket,
            401,
            {
              error: {
                code: error.code,
                message:
                  error.code === "auth_unconfigured"
                    ? "Authentication is not configured"
                    : "Invalid Supabase access token",
              },
            },
            responseHeaders,
          );
          return;
        }

        logEvent({
          event: "gateway_ws_upstream_failed",
          level: "error",
          agent_id: requestAgentId(request),
          error: errorMessage(error),
        });
        socket.destroy();
      }
    });
  });
}
