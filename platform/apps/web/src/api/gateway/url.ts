import { isValidUuid, type RuntimeScope, type WsConnectQuery } from "../ws-types";
import { resolveBrokerBase } from "../broker";

function normalizeGatewayWsUrl(rawUrl: string): string {
  const base = rawUrl.trim();
  if (!base) return base;

  try {
    const url = new URL(base);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/ws";
    }
    return url.toString();
  } catch {
    return base;
  }
}

function deriveWsUrlFromHttpBase(rawUrl: string): string {
  const base = rawUrl.trim();
  if (!base) return "";

  try {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Resolve the gateway WebSocket URL for the React app. */
export function resolveGatewayWsUrl(): string {
  // Explicit override
  const fromEnv = import.meta.env.VITE_GATEWAY_WS_URL?.trim() || "";
  if (fromEnv) return normalizeGatewayWsUrl(fromEnv);

  // Local dev: broker proxies WS to the engine gateway
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return "ws://localhost:3100/ws";
  }

  return deriveWsUrlFromHttpBase(resolveBrokerBase());
}

/**
 * Append runtime scope query params to the WS URL.
 * Requires a fully resolved `RuntimeScope`.
 * If scope is not yet resolved, callers must NOT connect.
 */
export function withGatewayRuntimeScope(wsUrl: string, scope: RuntimeScope): string {
  const base = String(wsUrl || "").trim();
  if (!base) return base;
  try {
    if (!isValidUuid(scope.agentId) || !isValidUuid(scope.workspaceId)) {
      throw new Error("invalid_runtime_scope");
    }
    const url = new URL(base);
    const q: WsConnectQuery = {
      session_key: scope.sessionKey,
      agent_id: scope.agentId,
      workspace_id: scope.workspaceId,
    };
    url.searchParams.set("session_key", q.session_key);
    url.searchParams.set("agent_id", q.agent_id);
    url.searchParams.set("workspace_id", q.workspace_id);
    return url.toString();
  } catch {
    return base;
  }
}

export function gatewayAuthProtocols(token: string | null | undefined): string[] | undefined {
  const trimmed = token?.trim();
  return trimmed ? ["platform.v1", `bearer.${trimmed}`] : undefined;
}
