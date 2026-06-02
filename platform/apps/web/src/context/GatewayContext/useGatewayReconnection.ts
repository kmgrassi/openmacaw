import { useCallback } from "react";
import type { AuthStateAgent } from "../../api/ws-types";
import type { useGatewayState } from "./useGatewayState";

type GatewayState = ReturnType<typeof useGatewayState>;

export function useGatewayReconnection({
  state,
  targetOverride,
}: {
  state: GatewayState;
  targetOverride: AuthStateAgent | null;
}) {
  const clearReconnectTimer = useCallback(() => {
    if (state.reconnectTimerRef.current !== null) {
      window.clearTimeout(state.reconnectTimerRef.current);
      state.reconnectTimerRef.current = null;
    }
  }, [state.reconnectTimerRef]);

  const scheduleReconnect = useCallback(
    (delayMs = 2_000) => {
      if (!state.allowReconnectRef.current) return;
      clearReconnectTimer();
      state.reconnectTimerRef.current = window.setTimeout(() => {
        state.reconnectTimerRef.current = null;
        state.setReconnectNonce((value) => value + 1);
      }, delayMs);
    },
    [
      clearReconnectTimer,
      state.allowReconnectRef,
      state.reconnectTimerRef,
      state.setReconnectNonce,
    ],
  );

  const disconnect = useCallback(() => {
    state.connectionGenerationRef.current += 1;
    state.allowReconnectRef.current = false;
    clearReconnectTimer();
    state.clientRef.current?.stop();
    state.clientRef.current = null;
    state.connectPromiseRef.current = null;
    state.setConnected(false);
    state.setHello(null);
    state.setStatus("scope_missing");
    state.setTarget(targetOverride);
  }, [
    clearReconnectTimer,
    state.allowReconnectRef,
    state.clientRef,
    state.connectPromiseRef,
    state.connectionGenerationRef,
    state.setConnected,
    state.setHello,
    state.setStatus,
    state.setTarget,
    targetOverride,
  ]);

  return {
    clearReconnectTimer,
    scheduleReconnect,
    disconnect,
  };
}
