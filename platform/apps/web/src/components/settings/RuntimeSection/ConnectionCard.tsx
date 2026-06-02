import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../../ui/KeyValueGrid";
import { statusToneClass, statusToneForValue } from "../../ui/status-tones";
import { formatStatusLabel } from "./formatters";

type Props = {
  gatewayReady: boolean | null;
  hello: {
    protocol?: number;
    server?: {
      version: string;
      connId: string;
    };
  } | null;
  status: string;
  onConnect: () => void;
  onDisconnect: () => void;
};

export function ConnectionCard({
  gatewayReady,
  hello,
  status,
  onConnect,
  onDisconnect,
}: Props) {
  return (
    <Card>
      <h3 className="text-sm font-medium text-slate-300 mb-3">Connection</h3>
      <div className="mb-3 flex gap-2">
        <Button
          size="sm"
          onClick={onConnect}
          disabled={status === "connecting" || status === "connected"}
        >
          Connect
        </Button>
        <Button size="sm" variant="ghost" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
      <KeyValueGrid className="text-sm">
        <KeyValuePair label="Status">
          <Badge
            className={`border ${statusToneClass(
              statusToneForValue(status, "warning"),
              "pill",
            )}`}
          >
            {formatStatusLabel(status)}
          </Badge>
        </KeyValuePair>

        <KeyValuePair label="Gateway reachable">
          {gatewayReady === null ? "Unknown" : gatewayReady ? "Yes" : "No"}
        </KeyValuePair>

        {hello?.server && (
          <>
            <KeyValuePair
              label="Server version"
              valueClassName="font-mono text-xs text-slate-300"
            >
              {hello.server.version}
            </KeyValuePair>
            <KeyValuePair
              label="Connection ID"
              valueClassName="font-mono text-xs text-slate-300"
            >
              {hello.server.connId}
            </KeyValuePair>
          </>
        )}

        {hello?.protocol !== undefined && (
          <KeyValuePair label="Protocol">v{hello.protocol}</KeyValuePair>
        )}
      </KeyValueGrid>
    </Card>
  );
}
