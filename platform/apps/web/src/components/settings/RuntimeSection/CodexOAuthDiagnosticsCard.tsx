import type { AgentDiagnosticResponse } from "../../../api/agent-diagnostic";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../../ui/KeyValueGrid";
import {
  codexOAuthStatusVariant,
  formatSessionTime,
  formatStatusLabel,
} from "./formatters";

export function CodexOAuthDiagnosticsCard({
  diagnostic,
  error,
  loading,
  onRefresh,
}: {
  diagnostic: AgentDiagnosticResponse["codexOAuth"];
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
            Codex OAuth diagnostics
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            ChatGPT OAuth, routing, token, and worker bridge readiness for the
            selected coding agent.
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
          <Badge variant={codexOAuthStatusVariant(diagnostic.status)}>
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
            ? "ChatGPT OAuth ready"
            : "ChatGPT OAuth missing"}
        </KeyValuePair>
        <KeyValuePair label="Auth mode" valueClassName="font-mono text-xs">
          {diagnostic.credential.authMode}
        </KeyValuePair>
        <KeyValuePair label="Token">
          {diagnostic.credential.token.present
            ? diagnostic.credential.token.refreshable
              ? "Present, refreshable"
              : "Present"
            : "Missing"}
        </KeyValuePair>
        <KeyValuePair label="Expires">
          {formatSessionTime(diagnostic.credential.token.expiresAt)}
        </KeyValuePair>
        <KeyValuePair label="Injected env" valueClassName="font-mono text-xs">
          {diagnostic.runtimeBridge.credentialEnv}
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
