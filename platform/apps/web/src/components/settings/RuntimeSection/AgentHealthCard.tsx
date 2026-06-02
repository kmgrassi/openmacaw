import type { AgentHealthResponse } from "../../../../../../contracts/agent-health";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../../ui/KeyValueGrid";
import { formatDateTime, formatStatusLabel } from "./formatters";

export function AgentHealthCard({
  agentHealth,
  error,
}: {
  agentHealth: AgentHealthResponse;
  error: string | null;
}) {
  return (
    <Card>
      <h3 className="text-sm font-medium text-slate-300 mb-3">Agent health</h3>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      <KeyValueGrid className="text-sm">
        <KeyValuePair label="Status">
          <Badge
            variant={
              agentHealth.status === "healthy"
                ? "success"
                : agentHealth.status === "unhealthy"
                  ? "error"
                  : "warning"
            }
          >
            {formatStatusLabel(agentHealth.status)}
          </Badge>
        </KeyValuePair>
        <KeyValuePair label="Checked">
          {formatDateTime(agentHealth.checkedAt)}
        </KeyValuePair>
        <KeyValuePair label="Last failure">
          {agentHealth.lastFailure
            ? `${agentHealth.lastFailure.sourceLayer}:${agentHealth.lastFailure.code} - ${agentHealth.lastFailure.message}`
            : "None"}
        </KeyValuePair>
      </KeyValueGrid>
    </Card>
  );
}
