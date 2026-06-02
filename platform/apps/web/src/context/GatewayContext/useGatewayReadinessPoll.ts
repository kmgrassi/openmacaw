import { useEffect } from "react";
import { fetchGatewayReady } from "../../api/broker-runtime";

export function useGatewayReadinessPoll({
  clearReconnectTimer,
  setGatewayReady,
}: {
  clearReconnectTimer: () => void;
  setGatewayReady: (ready: boolean | null) => void;
}) {
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;

    const pollGatewayReady = async () => {
      const ready = await fetchGatewayReady();
      if (disposed) return;
      setGatewayReady(ready);
      timer = window.setTimeout(() => {
        void pollGatewayReady();
      }, 5_000);
    };

    void pollGatewayReady();

    return () => {
      disposed = true;
      clearReconnectTimer();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [clearReconnectTimer, setGatewayReady]);
}
