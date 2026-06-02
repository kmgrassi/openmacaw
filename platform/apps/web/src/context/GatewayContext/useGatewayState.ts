import { useEffect, useRef, useState } from "react";
import type { GatewayClient } from "../../api/gateway";
import type {
  AuthStateAgent,
  GatewayEventFrame,
  GatewayHelloOk,
  PrepareError,
  RuntimeScope,
} from "../../api/ws-types";
import {
  initialGatewayDiagnostics,
  type GatewayDiagnostics,
  type GatewayStatus,
} from "./types";

export function useGatewayState({
  autoConnect,
  targetOverride,
}: {
  autoConnect: boolean;
  targetOverride: AuthStateAgent | null;
}) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<GatewayStatus>(
    autoConnect ? "resolving_scope" : "scope_missing",
  );
  const [hello, setHello] = useState<GatewayHelloOk | null>(null);
  const [diagnostics, setDiagnostics] = useState<GatewayDiagnostics>(
    initialGatewayDiagnostics,
  );
  const [gatewayReady, setGatewayReady] = useState<boolean | null>(null);
  const [scope, setScope] = useState<RuntimeScope | null>(null);
  const [target, setTarget] = useState<AuthStateAgent | null>(targetOverride);
  const [prepareError, setPrepareError] = useState<PrepareError | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const clientRef = useRef<GatewayClient | null>(null);
  const listenersRef = useRef<Set<(evt: GatewayEventFrame) => void>>(new Set());
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const allowReconnectRef = useRef(autoConnect);
  const connectionGenerationRef = useRef(0);

  useEffect(() => {
    setTarget(targetOverride);
  }, [targetOverride]);

  return {
    connected,
    setConnected,
    status,
    setStatus,
    hello,
    setHello,
    diagnostics,
    setDiagnostics,
    gatewayReady,
    setGatewayReady,
    scope,
    setScope,
    target,
    setTarget,
    prepareError,
    setPrepareError,
    reconnectNonce,
    setReconnectNonce,
    clientRef,
    listenersRef,
    connectPromiseRef,
    reconnectTimerRef,
    allowReconnectRef,
    connectionGenerationRef,
  };
}
