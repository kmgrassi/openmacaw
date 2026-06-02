import { Card } from "../../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../../ui/KeyValueGrid";

type Scope = {
  agentId: string;
  workspaceId: string;
  sessionKey: string;
};

export function ResolvedScopeCard({
  scope,
  status,
}: {
  scope: Scope | null;
  status: string;
}) {
  return (
    <Card>
      <h3 className="text-sm font-medium text-slate-300 mb-3">
        Resolved scope
      </h3>
      {scope ? (
        <KeyValueGrid className="text-sm">
          <KeyValuePair
            label="Agent ID"
            valueClassName="break-all font-mono text-xs text-slate-300"
          >
            {scope.agentId}
          </KeyValuePair>
          <KeyValuePair
            label="Workspace ID"
            valueClassName="break-all font-mono text-xs text-slate-300"
          >
            {scope.workspaceId}
          </KeyValuePair>
          <KeyValuePair
            label="Session key"
            valueClassName="break-all font-mono text-xs text-slate-300"
          >
            {scope.sessionKey}
          </KeyValuePair>
        </KeyValueGrid>
      ) : (
        <p className="text-sm text-slate-500">
          {status === "scope_missing"
            ? "No scope resolved — complete onboarding to connect."
            : "Resolving scope…"}
        </p>
      )}
    </Card>
  );
}
