import { useGatewayContext } from "../context/GatewayContext";
import { cn } from "../lib/cn";
import { statusToneDotClass } from "./ui/status-tones";

export function ConnectionHealth() {
  const { connected } = useGatewayContext();

  return (
    <div
      className="flex items-center gap-1.5"
      title={connected ? "Gateway connected" : "Gateway disconnected"}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          statusToneDotClass(connected ? "success" : "error", {
            glow: connected,
            pulse: !connected,
          }),
        )}
      />
      <span className="hidden text-xs text-slate-400 sm:inline">
        {connected ? "Connected" : "Disconnected"}
      </span>
    </div>
  );
}
