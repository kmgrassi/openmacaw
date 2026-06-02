import type { AgentDiagnosticResponse } from "../../../api/agent-diagnostic";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../../ui/KeyValueGrid";
import { claudeCodeStatusVariant, formatStatusLabel } from "./formatters";

export function ClaudeCodeDiagnosticsCard({
  diagnostic,
  error,
  loading,
  onRefresh,
}: {
  diagnostic: AgentDiagnosticResponse["claudeCode"];
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!diagnostic?.applicable) {
    return null;
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-slate-300">
            Claude Code diagnostics
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Runner, credential, bridge, and permission readiness for the
            selected coding backend.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          loading={loading}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      <KeyValueGrid className="text-sm">
        <KeyValuePair label="Status">
          <Badge variant={claudeCodeStatusVariant(diagnostic.status)}>
            {formatStatusLabel(diagnostic.status)}
          </Badge>
        </KeyValuePair>
        <KeyValuePair label="Runner" valueClassName="font-mono text-xs">
          {diagnostic.runnerKind ?? "N/A"}
        </KeyValuePair>
        <KeyValuePair label="Provider" valueClassName="font-mono text-xs">
          {diagnostic.provider ?? "N/A"}
        </KeyValuePair>
        <KeyValuePair label="Model" valueClassName="font-mono text-xs">
          {diagnostic.model ?? "N/A"}
        </KeyValuePair>
        <KeyValuePair label="Credential">
          {diagnostic.credential.ready
            ? "Anthropic credential ready"
            : "Anthropic credential missing"}
        </KeyValuePair>
        <KeyValuePair label="Bridge">
          {diagnostic.runtimeBridge.reported
            ? `${formatStatusLabel(diagnostic.runtimeBridge.status)}${
                diagnostic.runtimeBridge.sessionId
                  ? ` (${diagnostic.runtimeBridge.sessionId})`
                  : ""
              }`
            : "No bridge session reported"}
        </KeyValuePair>
        <KeyValuePair label="Tool profile" valueClassName="font-mono text-xs">
          {diagnostic.permissions.toolProfile ?? "N/A"}
        </KeyValuePair>
        <KeyValuePair
          label="Permission mode"
          valueClassName="font-mono text-xs"
        >
          {diagnostic.permissions.permissionMode}
        </KeyValuePair>
        <KeyValuePair label="Tools" valueClassName="font-mono text-xs">
          {diagnostic.permissions.tools.join(", ")}
        </KeyValuePair>
      </KeyValueGrid>

      {diagnostic.blockers.length > 0 && (
        <div className="mt-3 space-y-1">
          {diagnostic.blockers.map((blocker) => (
            <p key={blocker} className="text-xs text-amber-300">
              {blocker}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}
