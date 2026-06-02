import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  GatewayClient,
  gatewayAuthProtocols,
  resolveGatewayWsUrl,
  withGatewayRuntimeScope,
} from "../../api/gateway";
import { fetchAuthState } from "../../api/broker-auth";
import { prepareRuntime } from "../../api/broker-runtime";
import { getSupabaseAccessToken } from "../../api/supabase";
import type {
  AuthStateAgent,
  GatewayEventFrame,
  GatewayHelloOk,
  PrepareError,
  RuntimeScope,
} from "../../api/ws-types";
import {
  isValidUuid,
  makeSessionKey,
  WS_CLOSE_CODES,
} from "../../api/ws-types";
import type { GatewayDiagnostics, GatewayStatus } from "./types";

export async function resolveScope({
  scopeOverride,
  targetOverride,
  setStatus,
}: {
  scopeOverride: RuntimeScope | null;
  targetOverride: AuthStateAgent | null;
  setStatus: (status: GatewayStatus) => void;
}) {
  let resolvedScope: RuntimeScope | null = null;
  let resolvedTarget: AuthStateAgent | null = targetOverride;
  let fetchFailed = false;

  if (scopeOverride) {
    resolvedScope = scopeOverride;
  } else {
    try {
      const auth = await fetchAuthState();
      const agentId = auth.resolvedAgentId?.trim() || null;
      const workspaceId = auth.workspaceId?.trim() || null;
      resolvedTarget =
        auth.agents.find((agent) => agent.id === agentId) ??
        auth.agents.find((agent) => agent.isResolved) ??
        auth.agents[0] ??
        null;

      if (
        agentId &&
        workspaceId &&
        isValidUuid(agentId) &&
        isValidUuid(workspaceId)
      ) {
        resolvedScope = {
          agentId,
          workspaceId,
          sessionKey: makeSessionKey(agentId),
        };
      }
    } catch (err) {
      fetchFailed = true;
      console.warn("[gateway-context] auth-state fetch failed:", err);
    }
  }

  if (!resolvedScope && fetchFailed) {
    setStatus("error");
    console.warn(
      "[gateway-context] scope resolution failed after auth fetch error",
    );
    throw new Error("Could not resolve runtime scope");
  }

  if (!resolvedScope) {
    setStatus("scope_missing");
    console.warn("[gateway-context] no runtime scope resolved");
    throw new Error("No resolved runtime scope");
  }

  return {
    resolvedScope,
    resolvedTarget,
  };
}

export async function prepareGatewayRuntime({
  resolvedScope,
  setPrepareError,
  setStatus,
  scheduleReconnect,
  ensureCurrentConnection,
}: {
  resolvedScope: RuntimeScope;
  setPrepareError: (error: PrepareError | null) => void;
  setStatus: (status: GatewayStatus) => void;
  scheduleReconnect: (delayMs?: number) => void;
  ensureCurrentConnection: () => void;
}) {
  const prepared = await prepareRuntime(resolvedScope.agentId);
  ensureCurrentConnection();
  if (!prepared.readyToConnect) {
    setStatus("error");
    setPrepareError(prepared.prepareError ?? null);
    console.warn(
      "[gateway-context] runtime preparation failed:",
      prepared.reasons,
      prepared.prepareError,
    );
    scheduleReconnect(3_000);
    return false;
  }

  setPrepareError(null);
  return true;
}

export async function initializeWebSocket({
  resolvedScope,
  generation,
  connectionGenerationRef,
  clientRef,
  listenersRef,
  setConnected,
  setDiagnostics,
  setHello,
  setStatus,
  scheduleReconnect,
  ensureCurrentConnection,
}: {
  resolvedScope: RuntimeScope;
  generation: number;
  connectionGenerationRef: MutableRefObject<number>;
  clientRef: MutableRefObject<GatewayClient | null>;
  listenersRef: MutableRefObject<Set<(evt: GatewayEventFrame) => void>>;
  setConnected: (connected: boolean) => void;
  setDiagnostics: Dispatch<SetStateAction<GatewayDiagnostics>>;
  setHello: (hello: GatewayHelloOk | null) => void;
  setStatus: (status: GatewayStatus) => void;
  scheduleReconnect: (delayMs?: number) => void;
  ensureCurrentConnection: () => void;
}) {
  const baseWsUrl = resolveGatewayWsUrl();
  let accessToken: string | undefined;
  try {
    accessToken = await getSupabaseAccessToken();
  } catch {
    accessToken = undefined;
  }
  ensureCurrentConnection();
  const wsUrl = withGatewayRuntimeScope(baseWsUrl, resolvedScope);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const client = new GatewayClient({
      url: wsUrl,
      protocols: gatewayAuthProtocols(accessToken),
      onOpen: () => {
        if (connectionGenerationRef.current !== generation) return;
        setDiagnostics((current) => ({
          ...current,
          lastOpenAt: Date.now(),
        }));
      },
      onSendFrame: (frameType) => {
        if (connectionGenerationRef.current !== generation) return;
        setDiagnostics((current) => ({
          ...current,
          lastFrameType: frameType,
          lastFrameAt: Date.now(),
          ...(frameType === "req:connect"
            ? { lastConnectSentAt: Date.now() }
            : {}),
        }));
      },
      onReceiveFrame: (frameType) => {
        if (connectionGenerationRef.current !== generation) return;
        setDiagnostics((current) => ({
          ...current,
          lastFrameType: frameType,
          lastFrameAt: Date.now(),
        }));
      },
      onHello: (h) => {
        if (connectionGenerationRef.current !== generation) {
          return;
        }
        settled = true;
        setConnected(true);
        setStatus("connected");
        setHello(h);
        setDiagnostics((current) => ({
          ...current,
          lastHelloAt: Date.now(),
          lastFrameType: "hello-ok",
          lastFrameAt: Date.now(),
        }));
        console.debug("[gateway-context] websocket connected", {
          agentId: resolvedScope.agentId,
          sessionKey: resolvedScope.sessionKey,
        });
        resolve();
      },
      onEvent: (evt) => {
        if (connectionGenerationRef.current !== generation) return;
        for (const handler of listenersRef.current) {
          try {
            handler(evt);
          } catch (err) {
            console.error("[gateway-context] event handler error:", err);
          }
        }
      },
      onClose: ({ code, reason }) => {
        if (connectionGenerationRef.current !== generation) return;
        clientRef.current = null;
        setConnected(false);
        setHello(null);
        const isAbnormal = code !== 1000;
        setDiagnostics((current) => ({
          ...current,
          lastCloseCode: code,
          lastCloseReason: reason || null,
          lastAbnormalCloseAt: isAbnormal ? Date.now() : null,
        }));
        console.warn("[gateway-context] websocket closed", {
          code,
          reason,
          agentId: resolvedScope.agentId,
          sessionKey: resolvedScope.sessionKey,
        });
        if (!settled) {
          settled = true;
          reject(
            new Error(
              code === WS_CLOSE_CODES.AUTH_FAILED
                ? "Gateway authentication failed"
                : "Gateway closed before connect",
            ),
          );
        }
        if (code === WS_CLOSE_CODES.RUNTIME_NOT_PREPARED) {
          setStatus("error");
          void prepareRuntime(resolvedScope.agentId)
            .catch((err) => {
              console.warn("[gateway-context] runtime re-prepare failed:", err);
            })
            .finally(() => {
              scheduleReconnect();
            });
          return;
        }
        setStatus("error");
        scheduleReconnect();
      },
    });
    ensureCurrentConnection();
    clientRef.current = client;
    client.start();
  });
}
